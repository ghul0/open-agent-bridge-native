import { EventEmitter } from "node:events";
import { WebSocket } from "ws";

export type CodexDeliveryPolicy = "auto" | "steer" | "queue";
export type CodexRuntimeState = "connecting" | "idle" | "busy" | "disconnected" | "error";
export interface CodexDelivery { policy: CodexDeliveryPolicy; messageId?: string }
export interface CodexDeliveryResult {
  state: "runtime_accepted" | "held" | "failed" | "delivery_unknown";
  method?: "turn/start" | "turn/steer";
  threadId: string;
  turnId?: string;
  expectedTurnId?: string;
  detail?: string;
}
export interface CodexRuntimeHealth { connected: boolean; initialized: boolean; threadId: string; state: CodexRuntimeState; activeTurnId: string | null }
export interface CodexRuntimeOptions { appServerUrl: string; threadId: string; onState?: (health: CodexRuntimeHealth) => void; requestTimeoutMs?: number }
type RpcMessage = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };
type Pending = { method: string; sent: boolean; resolve: (value: unknown) => void; reject: (error: RpcFailure) => void; timer: NodeJS.Timeout };
class RpcFailure extends Error { constructor(message: string, readonly uncertain = false, readonly code?: number) { super(message); } }

export class CodexRuntime extends EventEmitter {
  readonly threadId: string;
  private readonly url: string;
  private readonly onState?: (health: CodexRuntimeHealth) => void;
  private readonly timeoutMs: number;
  private ws: WebSocket | null = null;
  private initialized = false;
  private state: CodexRuntimeState = "disconnected";
  private activeTurnId: string | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(options: CodexRuntimeOptions) { super(); this.url = options.appServerUrl; this.threadId = options.threadId; this.onState = options.onState; this.timeoutMs = options.requestTimeoutMs ?? 30_000; }
  health(): CodexRuntimeHealth { return { connected: this.ws?.readyState === WebSocket.OPEN, initialized: this.initialized, threadId: this.threadId, state: this.state, activeTurnId: this.activeTurnId }; }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.setState("connecting");
    this.ws = await new Promise<WebSocket>((resolve, reject) => { const ws = new WebSocket(this.url); ws.once("open", () => resolve(ws)); ws.once("error", reject); });
    this.ws.on("message", (data) => { try { this.handle(JSON.parse(String(data)) as RpcMessage); } catch { this.setState("error"); } });
    this.ws.on("close", () => this.onClose());
    await this.request("initialize", { clientInfo: { name: "native-agent-broker-codex", version: "0.1.0" }, capabilities: { experimentalApi: true }, protocolVersion: "0.1.0" });
    this.send({ method: "initialized" }); this.initialized = true;
    const thread = await this.readBoundThread();
    this.applyThread(thread);
  }

  async deliver(text: string, delivery: CodexDelivery): Promise<CodexDeliveryResult> {
    if (!this.initialized) return this.result("failed", "runtime not connected");
    try {
      const thread = await this.readBoundThread();
      this.applyThread(thread);
      const idle = thread.status?.type === "idle";
      if (idle) return await this.start(text, delivery.messageId);
      if (delivery.policy === "queue") return this.result("failed", "thread busy; explicit retry required for queue policy");
      const expectedTurnId = this.activeTurnId ?? this.activeTurnFrom(thread);
      if (!expectedTurnId) return this.result("held", "active turn id unavailable; wait for bound turn/started event");
      return await this.steer(text, expectedTurnId, delivery.messageId);
    } catch (error) {
      const failure = error instanceof RpcFailure ? error : new RpcFailure(error instanceof Error ? error.message : String(error));
      return this.result(failure.uncertain ? "delivery_unknown" : "failed", failure.message);
    }
  }

  disconnect(): void { this.ws?.close(); }

  private async start(text: string, messageId?: string): Promise<CodexDeliveryResult> {
    try {
      const result = await this.request("turn/start", { threadId: this.threadId, input: [{ type: "text", text }], clientUserMessageId: messageId ?? null }) as { turn?: { id?: string }; turnId?: string };
      this.activeTurnId = result.turn?.id ?? result.turnId ?? null; this.setState("busy");
      return { ...this.result("runtime_accepted"), method: "turn/start", turnId: this.activeTurnId ?? undefined };
    } catch (error) { return this.deliveryFailure(error); }
  }

  private async steer(text: string, expectedTurnId: string, messageId?: string): Promise<CodexDeliveryResult> {
    try {
      const result = await this.request("turn/steer", { threadId: this.threadId, expectedTurnId, input: [{ type: "text", text }] }) as { turnId?: string };
      return { ...this.result("runtime_accepted"), method: "turn/steer", turnId: result.turnId ?? expectedTurnId, expectedTurnId };
    } catch (error) {
      const failure = error instanceof RpcFailure ? error : new RpcFailure(String(error));
      if (!failure.uncertain) {
        const thread = await this.readBoundThread(); this.applyThread(thread);
        if (thread.status?.type === "idle") return this.start(text, messageId);
        return this.result("failed", `state changed before steer; explicit retry required: ${failure.message}`);
      }
      return this.deliveryFailure(failure);
    }
  }

  private deliveryFailure(error: unknown): CodexDeliveryResult { const f = error instanceof RpcFailure ? error : new RpcFailure(String(error)); return this.result(f.uncertain ? "delivery_unknown" : "failed", f.message); }
  private result(state: CodexDeliveryResult["state"], detail?: string): CodexDeliveryResult { return { state, threadId: this.threadId, ...(detail ? { detail } : {}) }; }

  private async readBoundThread(): Promise<ThreadView> {
    const result = await this.request("thread/read", { threadId: this.threadId, includeTurns: true }) as { thread?: ThreadView };
    if (result.thread?.id !== this.threadId) throw new RpcFailure(`Bound thread mismatch: ${result.thread?.id ?? "missing"}`);
    return result.thread;
  }
  private applyThread(thread: ThreadView): void { this.activeTurnId = thread.status?.type === "idle" ? null : (this.activeTurnFrom(thread) ?? this.activeTurnId); this.setState(thread.status?.type === "idle" ? "idle" : "busy"); }
  private activeTurnFrom(thread: ThreadView): string | null { const turns = thread.turns ?? []; const active = [...turns].reverse().find((turn) => turn.status === "inProgress" || turn.status === "active"); return active?.id ?? null; }

  private handle(message: RpcMessage): void {
    if (message.id !== undefined && message.method) { this.send({ id: message.id, error: { code: -32601, message: `Unsupported client request: ${message.method}` } }); return; }
    if (message.id !== undefined) { const p = this.pending.get(message.id); if (!p) return; clearTimeout(p.timer); this.pending.delete(message.id); message.error ? p.reject(new RpcFailure(message.error.message, false, message.error.code)) : p.resolve(message.result); return; }
    const threadId = message.params?.threadId as string | undefined;
    if (threadId !== this.threadId) return;
    if (message.method === "turn/started") { this.activeTurnId = this.turnId(message.params); this.setState("busy"); }
    else if (message.method === "turn/completed") { this.activeTurnId = null; this.setState("idle"); }
    else if (message.method === "thread/status/changed") { const status = (message.params?.status as { type?: string } | undefined)?.type; if (status === "idle") this.activeTurnId = null; this.setState(status === "idle" ? "idle" : status === "systemError" ? "error" : "busy"); }
  }
  private turnId(params?: Record<string, unknown>): string | null { return (params?.turn as { id?: string } | undefined)?.id ?? (params?.turnId as string | undefined) ?? null; }
  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const pending: Pending = { method, sent: false, resolve, reject, timer: setTimeout(() => { this.pending.delete(id); reject(new RpcFailure(`${method} timed out after send`, true)); }, this.timeoutMs) };
      this.pending.set(id, pending);
      try { this.send({ id, method, params }); pending.sent = true; } catch (error) { clearTimeout(pending.timer); this.pending.delete(id); reject(new RpcFailure(error instanceof Error ? error.message : String(error), pending.sent)); }
    });
  }
  private send(message: RpcMessage): void { if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("app-server websocket is not open"); this.ws.send(JSON.stringify(message)); }
  private onClose(): void { this.initialized = false; for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new RpcFailure(`${p.method} connection closed${p.sent ? " after send" : ""}`, p.sent)); this.pending.delete(id); } this.activeTurnId = null; this.setState("disconnected"); }
  private setState(state: CodexRuntimeState): void { this.state = state; const health = this.health(); this.onState?.(health); this.emit("state", health); }
}
interface ThreadView { id?: string; status?: { type?: string }; turns?: Array<{ id?: string; status?: string }> }
