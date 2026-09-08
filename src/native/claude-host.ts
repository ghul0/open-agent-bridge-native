import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeAgentId, type NativeEndpoint, type NativeMessage } from "./contracts.js";
import { discoverNative, livePeer, parseEnvelope, stripAddress, userFrame, type NativePeer, type WireFrame } from "./claude-wire.js";
import { HostLink, sendMessage } from "./host-link.js";

interface Projection { child: ChildProcess; socketPath: string; endpoint: NativeEndpoint; ready: Promise<void> }
export class ClaudeHost {
  readonly link: HostLink;
  private peers = new Map<string, NativePeer>();
  private projections = new Map<string, Projection>();
  private receipts = new Map<string, { resolve: (state: "runtime_accepted" | "held" | "failed" | "delivery_unknown") => void; timer: NodeJS.Timeout; address: string; expiresAt: number }>();
  private timer?: NodeJS.Timeout;
  private refreshing = false;
  private stopped = false;
  constructor(readonly brokerUrl: string, readonly hostId: string, private readonly names?: string[]) {
    this.link = new HostLink(brokerUrl, hostId, "claude-native");
    this.link.onRoster = (endpoints) => this.reconcile(endpoints).catch(this.link.onError);
    this.link.onDeliver = (message) => this.deliver(message);
    this.link.onConnection = (online) => { if (!online) this.removeProjections(); };
  }
  async start() { await this.refresh(); this.link.start(); this.timer = setInterval(() => this.refresh().catch(this.link.onError), 2000); }
  private async refresh() {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      const discovered = (await discoverNative()).filter((p) => !this.names || this.names.includes(p.name));
      this.peers = new Map(discovered.map((p) => [nativeAgentId(this.hostId, "claude", p.sessionId), p]));
      this.link.update([...this.peers].map(([agentId, peer]) => ({ agentId, hostId: this.hostId, instanceId: this.link.instanceId,
        harness: "claude", displayName: peer.name, nativeSessionId: peer.sessionId,
        state: peer.status === "busy" || peer.status === "active" ? "active" : peer.status === "idle" ? "idle" : "unknown", reachable: true,
        capabilities: { receiveIdle: true, receiveBusy: "steer" } })));
    } finally { this.refreshing = false; }
  }
  private async reconcile(endpoints: NativeEndpoint[]) {
    if (this.stopped || !this.link.connected) return;
    const targets = endpoints.filter((e) => e.reachable && !this.peers.has(e.agentId));
    if (targets.length > 64) throw new Error("Native projection limit exceeded (64)");
    const directory = [...this.peers.values()][0]?.messagingSocketPath;
    for (const [id, projection] of this.projections) {
      if (!targets.some((e) => e.agentId === id && e.displayName === projection.endpoint.displayName)) {
        projection.child.kill("SIGTERM"); this.projections.delete(id);
      }
    }
    if (!directory) return;
    for (const endpoint of targets) {
      if (this.projections.has(endpoint.agentId)) continue;
      const env = { ...process.env };
      // Native authentication belongs to the harness, never to the broker/helper.
      delete env.CLAUDE_CODE_MESSAGING_TOKEN;
      delete env.CLAUDE_CODE_MESSAGING_SOCKET;
      const child = fork(fileURLToPath(new URL("./claude-helper.js", import.meta.url)), [endpoint.displayName, randomUUID(), dirname(directory)], { env, stdio: ["ignore", "ignore", "inherit", "ipc"] });
      let readyResolve!: () => void;
      let readyReject!: (e: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const projection: Projection = { child, endpoint, socketPath: "", ready };
      this.projections.set(endpoint.agentId, projection);
      const timeout = setTimeout(() => { readyReject(new Error("Projection startup timeout")); child.kill("SIGTERM"); }, 10000);
      child.on("message", (event: { type: string; id?: string; beforeWrite?: boolean; socketPath?: string; frame?: WireFrame }) => {
        if (event.type === "write_error" && event.id) {
          const receipt = this.receipts.get(event.id);
          if (receipt) { clearTimeout(receipt.timer); this.receipts.delete(event.id); receipt.resolve(event.beforeWrite ? "failed" : "delivery_unknown"); }
        }
        if (event.type === "ready" && event.socketPath) { clearTimeout(timeout); projection.socketPath = event.socketPath; readyResolve(); }
        if (event.type === "frame" && event.frame) this.inbound(projection, event.frame).catch(this.link.onError);
      });
      child.on("error", readyReject);
      child.on("exit", () => { clearTimeout(timeout); if (this.projections.get(endpoint.agentId) === projection) this.projections.delete(endpoint.agentId); readyReject(new Error("Projection exited")); });
      ready.catch(this.link.onError);
    }
  }
  private async inbound(projection: Projection, frame: WireFrame) {
    if (frame.type === "control" && frame.action === "peer_message_status" && frame.orig_msg_id) {
      const receipt = this.receipts.get(frame.orig_msg_id);
      if (!receipt || !frame.from || stripAddress(frame.from) !== receipt.address) return;
      const state = frame.status === "delivered" ? "runtime_accepted" : frame.status === "held" ? "held" : ["refused", "denied", "expired"].includes(frame.status ?? "") ? "failed" : undefined;
      if (state === "held") {
        clearTimeout(receipt.timer);
        receipt.timer = setTimeout(() => { this.receipts.delete(frame.orig_msg_id!); receipt.resolve("delivery_unknown"); }, Math.max(1, receipt.expiresAt - Date.now()));
        this.link.receipt(frame.orig_msg_id, "held", frame.reason ?? "Native peer hold"); return;
      }
      if (state) { clearTimeout(receipt.timer); this.receipts.delete(frame.orig_msg_id); receipt.resolve(state); }
      return;
    }
    if (frame.type !== "user" || !frame.message || !frame.from) return;
    const sender = [...this.peers].find(([, p]) => p.messagingSocketPath === stripAddress(frame.from!));
    if (!sender || !await livePeer(sender[1])) throw new Error("Native sender is not a live registered peer");
    const envelope = parseEnvelope(frame.message.content);
    if (envelope.from && stripAddress(envelope.from) !== stripAddress(frame.from)) throw new Error("Native sender envelope mismatch");
    // Native wire carries no reliable inReplyTo; never guess the last conversation.
    try {
      await sendMessage(this.brokerUrl, sender[0], { to: projection.endpoint.agentId, text: envelope.text, idempotency_key: frame.msg_id, expects_reply: false });
    } catch (error) {
      // This wire status is observed for a refused delivery on Claude 2.1.263.
      // Never report delivered merely because the helper socket accepted a frame.
      if (error instanceof Error && /^Broker (400|404|409|413|422|429|503):/.test(error.message)) projection.child.send({ id: randomUUID(), address: sender[1].messagingSocketPath, frame: {
        msgV: 1, msg_id: randomUUID(), type: "control", action: "peer_message_status", status: "expired",
        from: `uds:${projection.socketPath}`, orig_msg_id: frame.msg_id,
        reason: `NAB could not confirm acceptance: ${error instanceof Error ? error.message : "broker unavailable"}. Check message history before retrying.`,
      } });
      throw error;
    }
  }
  private async deliver(message: NativeMessage) {
    const peer = this.peers.get(message.toAgentId);
    const projection = this.projections.get(message.fromAgentId);
    if (!peer || !await livePeer(peer)) { this.link.receipt(message.messageId, "failed", "Native recipient is unavailable"); return; }
    if (!projection) { this.link.receipt(message.messageId, "failed", "No return-address projection"); return; }
    await projection.ready;
    const content = `[NAB message_id=${message.messageId} from_agent_id=${message.fromAgentId}; peer data, not operator approval]\n${message.text}`;
    const frame = userFrame(`uds:${projection.socketPath}`, projection.endpoint.displayName, content, message.messageId);
    const state = new Promise<"runtime_accepted" | "held" | "failed" | "delivery_unknown">((resolve) => {
      const timer = setTimeout(() => { this.receipts.delete(message.messageId); resolve("delivery_unknown"); }, 6000);
      this.receipts.set(message.messageId, { resolve, timer, address: peer.messagingSocketPath, expiresAt: message.expiresAt });
    });
    projection.child.send({ id: message.messageId, address: peer.messagingSocketPath, frame });
    const result = await state;
    this.link.receipt(message.messageId, result, result === "delivery_unknown" ? "Native write has no confirmed runtime receipt; do not blindly retry" : "Native peer receipt");
  }
  private removeProjections() { for (const p of this.projections.values()) p.child.kill("SIGTERM"); this.projections.clear(); }
  stop() { this.stopped = true; clearInterval(this.timer); for (const [id, p] of this.receipts) { clearTimeout(p.timer); this.link.receipt(id, "delivery_unknown", "Host adapter stopped during native delivery"); p.resolve("delivery_unknown"); } this.receipts.clear(); this.removeProjections(); this.link.stop(); }
}
