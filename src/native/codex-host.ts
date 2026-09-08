import { CodexConnection, DEFAULT_CODEX_URL, RpcError, type RpcId } from "./codex-connection.js";
import { nativeAgentId, type NativeEndpoint, type NativeMessage } from "./contracts.js";
import { HostLink, peerText } from "./host-link.js";

export interface CodexHostOptions {
  brokerUrl: string;
  hostId: string;
  appServerUrl?: string;
  threadIds?: string[];
  onName?: (threadId: string, name: string) => void;
}

export interface CodexThreadInfo {
  threadId: string;
  name: string;
  updatedAt?: number;
  state: NativeEndpoint["state"];
  activeTurnId: string | null;
}

type ThreadView = {
  id?: string;
  name?: string | null;
  updatedAt?: number | string;
  updated_at?: number | string;
  status?: { type?: string; activeFlags?: string[] } | string;
  turns?: Array<{ id?: string; status?: string }>;
};
type ThreadRecord = CodexThreadInfo & { approvalIds: Set<RpcId> };

const RECONCILE_MS = 10_000;
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

export class CodexHost {
  readonly link: HostLink;
  private readonly connection: CodexConnection;
  private readonly hostId: string;
  private readonly allowlist?: Set<string>;
  private readonly onName?: CodexHostOptions["onName"];
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly requestThreads = new Map<RpcId, string>();
  private reconcileTimer?: NodeJS.Timeout;
  private started = false;
  private reconcileInFlight = false;
  private needsResubscribe = true;
  private rosterReady = false;
  private readonly pendingNames = new Map<string, string>();

  constructor(options: CodexHostOptions) {
    this.hostId = options.hostId;
    this.allowlist = options.threadIds ? new Set(options.threadIds) : undefined;
    this.onName = options.onName;
    this.link = new HostLink(options.brokerUrl, options.hostId, "codex-central");
    this.connection = new CodexConnection({ url: options.appServerUrl ?? DEFAULT_CODEX_URL });
    this.link.onDeliver = (message) => this.deliver(message);
    this.link.onRoster = (agents) => {
      this.rosterReady = agents.some((agent) => agent.instanceId === this.link.instanceId && agent.harness === "codex");
      if (this.rosterReady) this.flushNames();
    };
    this.connection.on("notification", (method: string, params: unknown) => this.onNotification(method, params));
    this.connection.on("serverRequest", (id: RpcId, method: string, params: unknown) => this.onServerRequest(id, method, params));
    this.connection.on("disconnected", () => this.markDisconnected());
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.connection.connect();
      await this.reconcile();
      this.link.start();
      this.reconcileTimer = setInterval(() => void this.reconcile().catch(this.reportError), RECONCILE_MS);
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  stop(): void {
    this.started = false;
    clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
    this.link.stop();
    this.connection.close();
  }

  async rename(threadId: string, name: string): Promise<void> {
    this.requireKnown(threadId);
    await this.connection.request("thread/name/set", { threadId, name });
    const thread = await this.readThread(threadId, false);
    this.upsert(thread);
  }

  listKnownThreads(): CodexThreadInfo[] {
    return [...this.threads.values()].map(({ approvalIds: _approvalIds, ...thread }) => ({ ...thread }));
  }

  resolve(nameOrId: string): CodexThreadInfo | undefined {
    const direct = this.threads.get(nameOrId);
    const matches = direct ? [direct] : [...this.threads.values()].filter((thread) => thread.name === nameOrId);
    if (matches.length > 1) throw new Error(`Ambiguous Codex thread name: ${nameOrId}`);
    const found = matches[0];
    if (!found) return undefined;
    const { approvalIds: _approvalIds, ...info } = found;
    return { ...info };
  }

  currentEndpointIds(): string[] {
    return [...this.threads.keys()].map((id) => nativeAgentId(this.hostId, "codex", id));
  }

  private readonly reportError = (error: unknown): void => {
    this.link.onError(error instanceof Error ? error : new Error(String(error)));
  };

  private async reconcile(): Promise<void> {
    if (this.reconcileInFlight || !this.started) return;
    this.reconcileInFlight = true;
    try {
    if (!this.connection.connected) await this.connection.connect();
    const listed = await this.listLoadedThreads();
    const seen = new Set<string>();
    for (const threadId of listed) {
      if (this.allowlist && !this.allowlist.has(threadId)) continue;
      seen.add(threadId);
      if (!this.threads.has(threadId) || this.needsResubscribe) {
        const resumed = await this.connection.request<{ thread?: ThreadView }>("thread/resume", { threadId });
        this.upsert(resumed.thread?.id ? resumed.thread : await this.readThread(threadId, false));
      } else {
        this.upsert(await this.readThread(threadId, false));
      }
    }
    for (const id of this.threads.keys()) if (!seen.has(id)) this.threads.delete(id);
    this.needsResubscribe = false;
    this.publish();
    } finally { this.reconcileInFlight = false; }
  }

  private async listLoadedThreads(): Promise<string[]> {
    const result: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { data?: string[]; nextCursor?: string | null } = await this.connection.request(
        "thread/loaded/list",
        { cursor, limit: 100 },
      );
      result.push(...(page.data ?? []));
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return result;
  }

  private async readThread(threadId: string, includeTurns: boolean): Promise<ThreadView> {
    const result = await this.connection.request<{ thread?: ThreadView }>("thread/read", { threadId, includeTurns });
    if (result.thread?.id !== threadId) throw new Error(`Thread mismatch for ${threadId}`);
    return result.thread;
  }

  private upsert(view: ThreadView): ThreadRecord {
    if (!view.id) throw new Error("Codex thread has no id");
    const previous = this.threads.get(view.id);
    const name = view.name?.trim() || `codex-${view.id.slice(0, 8)}`;
    const state = stateFrom(view, previous);
    const record: ThreadRecord = {
      threadId: view.id,
      name,
      updatedAt: parseUpdated(view.updatedAt ?? view.updated_at),
      state: previous?.approvalIds.size ? "awaiting_approval" : state,
      activeTurnId: activeTurn(view) ?? (state === "idle" ? null : previous?.activeTurnId ?? null),
      approvalIds: previous?.approvalIds ?? new Set(),
    };
    this.threads.set(view.id, record);
    if (view.name && view.name !== previous?.name) this.signalName(view.id, view.name);
    return record;
  }

  private publish(): void {
    const endpoints: NativeEndpoint[] = [...this.threads.values()].map((thread) => ({
      agentId: nativeAgentId(this.hostId, "codex", thread.threadId),
      hostId: this.hostId,
      instanceId: this.link.instanceId,
      harness: "codex",
      displayName: thread.name,
      nativeSessionId: thread.threadId,
      state: thread.state,
      reachable: this.connection.connected && thread.state !== "disconnected" && thread.state !== "error",
      capabilities: { receiveIdle: true, receiveBusy: "steer" },
    }));
    this.link.update(endpoints);
  }

  private async deliver(message: NativeMessage): Promise<void> {
    const threadId = this.threadIdFromAgent(message.toAgentId);
    if (!threadId) {
      this.link.receipt(message.messageId, "failed", "Codex endpoint is not registered by this adapter");
      return;
    }
    try {
      const view = await this.readThread(threadId, true);
      const thread = this.upsert(view);
      if (message.deliveryPolicy === "queue" && thread.state !== "idle") {
        this.link.receipt(message.messageId, "failed", "Thread busy; explicit retry required for queue policy");
        return;
      }
      if (thread.state !== "idle" && thread.state !== "active") {
        this.link.receipt(message.messageId, "failed", "Runtime cannot accept delivery in its current state; approvals remain with the operator");
        return;
      }
      const text = peerText(message).replace("\n\n", `\nrecipient_thread_name=${JSON.stringify(thread.name)}\nrecipient_thread_id=${threadId}\n\n`);
      if (thread.state === "idle") {
        await this.startTurn(threadId, text, message.messageId);
      } else {
        const turnId = thread.activeTurnId ?? activeTurn(view);
        if (!turnId) {
          this.link.receipt(message.messageId, "failed", "Active turn id unavailable; delivery was not attempted");
          return;
        }
        await this.steerOrFallback(threadId, turnId, text, message.messageId);
      }
      this.link.receipt(message.messageId, "runtime_accepted");
    } catch (error) {
      const uncertain = error instanceof RpcError && error.uncertain;
      this.link.receipt(message.messageId, uncertain ? "delivery_unknown" : "failed", error instanceof Error ? error.message : String(error));
    }
  }

  private async startTurn(threadId: string, text: string, messageId: string): Promise<void> {
    const result = await this.connection.request<{ turn?: { id?: string }; turnId?: string }>("turn/start", {
      threadId,
      input: [{ type: "text", text }],
      clientUserMessageId: messageId,
    });
    const thread = this.threads.get(threadId);
    if (thread) { thread.activeTurnId = result.turn?.id ?? result.turnId ?? null; thread.state = "active"; }
    this.publish();
  }

  private async steerOrFallback(threadId: string, expectedTurnId: string, text: string, messageId: string): Promise<void> {
    try {
      await this.connection.request("turn/steer", { threadId, expectedTurnId, input: [{ type: "text", text }] });
    } catch (error) {
      if (error instanceof RpcError && error.uncertain) throw error;
      const fresh = await this.readThread(threadId, true);
      this.upsert(fresh);
      if (stateFrom(fresh) === "idle") { await this.startTurn(threadId, text, messageId); return; }
      throw error;
    }
  }

  private onNotification(method: string, params: unknown): void {
    const value = asObject(params);
    if (method === "serverRequest/resolved") {
      const id = value.requestId as RpcId | undefined;
      const threadId = id === undefined ? undefined : this.requestThreads.get(id);
      if (id !== undefined) this.requestThreads.delete(id);
      if (threadId) { this.threads.get(threadId)?.approvalIds.delete(id!); void this.refreshState(threadId); }
      return;
    }
    const threadId = extractThreadId(value);
    if (!threadId || !this.threads.has(threadId)) return;
    if (method === "thread/closed") { this.threads.delete(threadId); this.publish(); return; }
    const thread = this.threads.get(threadId)!;
    if (method === "turn/started") { thread.activeTurnId = extractTurnId(value); thread.state = "active"; }
    else if (method === "turn/completed") { thread.activeTurnId = null; thread.state = thread.approvalIds.size ? "awaiting_approval" : "idle"; }
    else if (method === "thread/status/changed") thread.state = thread.approvalIds.size ? "awaiting_approval" : stateFrom({ status: value.status as ThreadView["status"] }, thread);
    else if (method === "thread/name/updated") {
      const name = typeof value.threadName === "string" ? value.threadName : null;
      if (name) { thread.name = name; this.signalName(threadId, name); }
    }
    this.publish();
  }

  private onServerRequest(id: RpcId, method: string, params: unknown): void {
    if (!APPROVAL_METHODS.has(method)) return;
    const threadId = extractThreadId(asObject(params));
    const thread = threadId ? this.threads.get(threadId) : undefined;
    if (!thread || !threadId) return;
    this.requestThreads.set(id, threadId);
    thread.approvalIds.add(id);
    thread.state = "awaiting_approval";
    this.publish();
  }

  private async refreshState(threadId: string): Promise<void> {
    try { this.upsert(await this.readThread(threadId, false)); this.publish(); } catch (error) { this.reportError(error); }
  }

  private markDisconnected(): void {
    this.needsResubscribe = true;
    this.requestThreads.clear();
    for (const thread of this.threads.values()) { thread.approvalIds.clear(); thread.state = "disconnected"; }
    this.publish();
  }

  private signalName(threadId: string, name: string): void {
    if (!this.onName) return;
    if (!this.rosterReady) { this.pendingNames.set(threadId, name); return; }
    this.onName(threadId, name);
  }

  private flushNames(): void {
    if (!this.onName) return;
    for (const [threadId, name] of this.pendingNames) this.onName(threadId, name);
    this.pendingNames.clear();
  }

  private threadIdFromAgent(agentId: string): string | undefined {
    return [...this.threads.keys()].find((id) => nativeAgentId(this.hostId, "codex", id) === agentId);
  }

  private requireKnown(threadId: string): void {
    if (!this.threads.has(threadId)) throw new Error(`Unknown Codex thread: ${threadId}`);
  }
}

function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function extractThreadId(value: Record<string, unknown>): string | undefined {
  return typeof value.threadId === "string" ? value.threadId : typeof (value.thread as { id?: unknown } | undefined)?.id === "string" ? (value.thread as { id: string }).id : undefined;
}
function extractTurnId(value: Record<string, unknown>): string | null {
  return typeof value.turnId === "string" ? value.turnId : typeof (value.turn as { id?: unknown } | undefined)?.id === "string" ? (value.turn as { id: string }).id : null;
}
function activeTurn(thread: ThreadView): string | null {
  return [...(thread.turns ?? [])].reverse().find((turn) => turn.status === "inProgress" || turn.status === "active")?.id ?? null;
}
function stateFrom(thread: ThreadView, previous?: ThreadRecord): NativeEndpoint["state"] {
  const status = typeof thread.status === "string" ? thread.status : thread.status?.type;
  const flags = typeof thread.status === "object" ? thread.status.activeFlags ?? [] : [];
  if (flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput")) return "awaiting_approval";
  if (status === "notLoaded") return "disconnected";
  if (status === "idle") return "idle";
  if (status === "systemError" || status === "error") return "error";
  if (status === "inProgress" || status === "active" || activeTurn(thread)) return "active";
  return previous?.state === "awaiting_approval" ? "awaiting_approval" : "unknown";
}
function parseUpdated(value: number | string | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed; }
  return undefined;
}
