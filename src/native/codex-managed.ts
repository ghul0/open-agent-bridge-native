import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { nativeAgentId, type NativeEndpoint } from "./contracts.js";
import { HostLink, peerText } from "./host-link.js";
import { CodexRuntime, type CodexRuntimeHealth } from "./codex-runtime.js";

export interface ManagedCodexOptions {
  name: string;
  project: string;
  brokerUrl: string;
  hostId: string;
  stateDir: string;
  codexBinary: string;
}
export interface ManagedCodexResult { agentId: string; threadId: string; bindingFile: string; exitCode: number | null }

export async function launchManagedCodex(options: ManagedCodexOptions): Promise<ManagedCodexResult> {
  const project = resolve(options.project);
  const sessionDir = join(resolve(options.stateDir), options.name);
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const bindingFile = join(sessionDir, "binding.json");
  const port = await freePort();
  const appServerUrl = `ws://127.0.0.1:${port}`;
  const mcpCommand = fileURLToPath(new URL("./cli.js", import.meta.url));
  const mcpConfig = `mcp_servers.native_agent_broker={command=${toml(process.execPath)},args=[${toml(mcpCommand)},${toml("mcp")}],env={NAB_BROKER_URL=${toml(options.brokerUrl)},NAB_BINDING_FILE=${toml(bindingFile)}}}`;
  const appServer = spawn(options.codexBinary, ["app-server", "--listen", appServerUrl, "-c", mcpConfig], { stdio: ["ignore", "inherit", "inherit"] });
  try {
    await waitForServer(appServerUrl, appServer);
    const threadId = await createManagedThread(appServerUrl, project);
    const agentId = nativeAgentId(options.hostId, "codex", threadId);
    await writeFile(bindingFile, `${JSON.stringify({ agentId, threadId, appServerUrl, name: options.name }, null, 2)}\n`, { mode: 0o600 });

    const hostLink = new HostLink(options.brokerUrl, options.hostId, `codex:${options.name}`);
    const endpoint = (health: CodexRuntimeHealth): NativeEndpoint => ({
      agentId, hostId: options.hostId, instanceId: hostLink.instanceId, harness: "codex", displayName: options.name,
      nativeSessionId: threadId, state: health.state === "busy" ? "active" : health.state === "idle" ? "idle" : health.state === "error" ? "error" : "disconnected",
      reachable: health.connected && health.initialized,
      capabilities: { receiveIdle: true, receiveBusy: "steer" },
    });
    const attachNonce = randomUUID();
    const tui = spawn(options.codexBinary, ["--remote", appServerUrl, "-C", project, "-a", "on-request", "-c", mcpConfig, "resume", threadId, `Reply exactly NAB-TUI-ATTACHED-${attachNonce}. Do not use tools.`], { stdio: "inherit" });
    await waitForTuiAttach(appServerUrl, threadId, attachNonce, tui);

    const runtime = new CodexRuntime({ appServerUrl, threadId });
    await runtime.connect();
    let reconnecting = false;
    runtime.on("state", (health: CodexRuntimeHealth) => {
      hostLink.update([endpoint(health)]);
      if (health.state === "disconnected" && tui.exitCode === null && !reconnecting) {
        reconnecting = true;
        reconnectRuntime(runtime, tui).finally(() => { reconnecting = false; });
      }
    });
    const deliveryTrace = join(sessionDir, "delivery-metadata.jsonl");
    hostLink.onDeliver = async (message) => {
      if (message.toAgentId !== agentId) return;
      const result = await runtime.deliver(peerText(message), { policy: message.deliveryPolicy, messageId: message.messageId });
      await appendFile(deliveryTrace, `${JSON.stringify({ timestamp: new Date().toISOString(), messageId: message.messageId, policy: message.deliveryPolicy, state: result.state, method: result.method, turnId: result.turnId, expectedTurnId: result.expectedTurnId })}\n`, { mode: 0o600 });
      hostLink.receipt(message.messageId, result.state, result.detail);
    };
    hostLink.update([endpoint(runtime.health())]); hostLink.start();
    const exitCode = await new Promise<number | null>((resolveExit, reject) => { tui.once("exit", resolveExit); tui.once("error", reject); });
    hostLink.stop(); runtime.disconnect();
    return { agentId, threadId, bindingFile, exitCode };
  } finally {
    appServer.kill("SIGTERM");
  }
}

async function reconnectRuntime(runtime: CodexRuntime, tui: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 8 && tui.exitCode === null; attempt++) {
    await delay(Math.min(250 * 2 ** attempt, 5_000));
    try { await runtime.connect(); return; } catch { /* retry only the existing bound thread */ }
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Could not allocate app-server port");
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}
async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`Codex app-server exited with ${child.exitCode}`);
    try { const ws = await open(url); ws.close(); return; } catch { await delay(100); }
  }
  throw new Error("Timed out waiting for Codex app-server");
}
async function createManagedThread(url: string, cwd: string): Promise<string> {
  const rpc = await Rpc.connect(url);
  try {
    await rpc.request("initialize", { clientInfo: { name: "nab-codex-launcher", version: "0.1.0" }, capabilities: {}, protocolVersion: "0.1.0" }); rpc.notify("initialized", {});
    const result = await rpc.request("thread/start", { cwd, ephemeral: false, approvalPolicy: "on-request", threadSource: "user" }) as { thread?: { id?: string }; threadId?: string };
    const threadId = result.thread?.id ?? result.threadId; if (!threadId) throw new Error("thread/start returned no threadId"); return threadId;
  } finally { rpc.close(); }
}
async function waitForTuiAttach(url: string, threadId: string, nonce: string, tui: ChildProcess): Promise<void> {
  const rpc = await Rpc.connect(url);
  try {
    await rpc.request("initialize", { clientInfo: { name: "nab-codex-attach-check", version: "0.1.0" }, capabilities: {}, protocolVersion: "0.1.0" }); rpc.notify("initialized", {});
    const marker = `NAB-TUI-ATTACHED-${nonce}`;
    for (let attempt = 0; attempt < 600; attempt++) {
      if (tui.exitCode !== null) throw new Error(`Codex TUI exited before attach proof (${tui.exitCode})`);
      try {
        const result = await rpc.request("thread/read", { threadId, includeTurns: true }) as { thread?: { id?: string; turns?: Array<{ items?: Array<{ type?: string; text?: string }> }> } };
        const items = result.thread?.turns?.flatMap((turn) => turn.items ?? []) ?? [];
        if (result.thread?.id === threadId && items.some((item) => item.type === "agentMessage" && item.text?.trim() === marker)) return;
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("list_turns is not supported yet"))) throw error;
        // An empty thread created before TUI resume has no turn history yet.
      }
      await delay(250);
    }
    throw new Error("Timed out waiting for model-produced TUI attach marker");
  } finally { rpc.close(); }
}
const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const toml = (value: string) => JSON.stringify(value);
const open = (url: string) => new Promise<WebSocket>((resolveOpen, reject) => { const ws = new WebSocket(url); ws.once("open", () => resolveOpen(ws)); ws.once("error", reject); });

class Rpc {
  private nextId = 1; private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private constructor(private ws: WebSocket) {
    ws.on("message", (raw) => this.message(JSON.parse(String(raw))));
    ws.on("close", () => this.rejectAll(new Error("App-server RPC connection closed")));
    ws.on("error", (error) => this.rejectAll(error));
  }
  static async connect(url: string) { return new Rpc(await open(url)); }
  request(method: string, params: object) {
    const id = this.nextId++;
    return new Promise<unknown>((resolveRequest, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 10_000);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method: string, params: object) { this.ws.send(JSON.stringify({ method, params })); }
  close() { this.rejectAll(new Error("RPC client closed")); this.ws.close(); }
  private rejectAll(error: Error) { for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(error); this.pending.delete(id); } }
  private message(message: { id?: number; method?: string; result?: unknown; error?: { message: string } }) {
    if (message.id !== undefined && message.method) { this.ws.send(JSON.stringify({ id: message.id, error: { code: -32601, message: `Unsupported client request: ${message.method}` } })); return; }
    if (message.id === undefined) return; const pending = this.pending.get(message.id); if (!pending) return; clearTimeout(pending.timer); this.pending.delete(message.id);
    message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
  }
}
