import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { WebSocket } from "ws";
import { DatabaseSync } from "node:sqlite";
import { RegistryServer } from "./server.js";
import { ChannelStore } from "./channel-store.js";
import { nativeAgentId, NativeSendSchema, type NativeEndpoint, type NativeServerFrame } from "../native/contracts.js";

const scratch = tmpdir();
function endpoint(hostId: string, session: string, state: NativeEndpoint["state"] = "idle", instanceId = "i1"): NativeEndpoint {
  return { agentId: nativeAgentId(hostId, "pi", session), hostId, instanceId, harness: "pi", displayName: session,
    nativeSessionId: session, state, reachable: true, capabilities: { receiveIdle: true, receiveBusy: "queue" } };
}

describe("native registry transport fixtures", () => {
  let dir: string;
  let dbPath: string;
  let server: RegistryServer;
  const clients: WebSocket[] = [];
  beforeEach(async () => {
    dir = mkdtempSync(join(scratch, "native-core-"));
    dbPath = join(dir, "registry.sqlite");
    server = new RegistryServer(0, { native: true, dbPath });
    await server.start();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const ws of clients.splice(0)) ws.terminate();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function connect(hostId: string, agents: NativeEndpoint[], adapterId?: string) {
    const ws = new WebSocket(server.address.replace("http:", "ws:") + "/ws");
    clients.push(ws);
    const frames: NativeServerFrame[] = [];
    ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    await once(ws, "open");
    const register = async (next: NativeEndpoint[], instanceId = next[0]?.instanceId ?? "i1") => {
      const start = frames.length;
      ws.send(JSON.stringify({ type: "native.register", hostId, adapterId, instanceId, endpoints: next }));
      await expect.poll(() => frames.slice(start).some((frame) => frame.type === "native.roster" &&
        next.every((agent) => frame.agents.some((item) => item.agentId === agent.agentId && item.state === agent.state && item.instanceId === instanceId)))).toBe(true);
    };
    await register(agents);
    return { ws, frames, register, deliveries: () => frames.filter((frame) => frame.type === "native.deliver") };
  }
  async function send(from: string, to: string, extra: Record<string, unknown> = {}) {
    const response = await fetch(`${server.address}/native/messages`, { method: "POST", headers: { "content-type": "application/json", "x-nab-agent-id": from },
      body: JSON.stringify({ to, text: "synthetic content", ...extra }) });
    return { status: response.status, body: await response.json() };
  }
  async function messages() {
    return (await (await fetch(`${server.address}/native/messages`)).json()).messages;
  }

  it("reports exact ASCII and UTF-8 rejection sizes without leaking content or metadata", async () => {
    const a = endpoint("host-a", "source");
    const b = endpoint("host-b", "target");
    await connect(a.hostId, [a]);
    const receiver = await connect(b.hostId, [b]);
    for (const text of ["x".repeat(262145), "😀".repeat(65537)]) {
      const result = await send(a.agentId, b.agentId, { text, conversation_id: "SECRET", password: "SECRET", from: "spoof" });
      expect(result.status).toBe(413);
      expect(result.body).toMatchObject({ code: "text_too_large", limit_bytes: 262144,
        actual_bytes: Buffer.byteLength(text, "utf8"), notification: "queued" });
      expect(result.body.error).toContain(`${Buffer.byteLength(text, "utf8")} bytes`);
    }
    await expect.poll(() => receiver.deliveries().length).toBe(1);
    const full = (await (await fetch(`${server.address}/native/messages?include_body=true`)).json()).messages;
    expect(full).toHaveLength(2);
    for (const notice of full) {
      expect(notice.fromAgentId).toBe(b.agentId);
      expect(notice.expectsReply).toBe(false);
      expect(notice.text).toContain("technical delivery failure");
      expect(notice.text).toContain(a.agentId);
      expect(notice.text).not.toContain("SECRET");
      expect(notice.text).not.toContain("spoof");
      expect(notice.text.length).toBeLessThan(1500);
    }
  });

  it("caps canonical source metadata and never copies a declared source or display name", async () => {
    const a = endpoint("host-a", "a".repeat(300)); a.displayName = "PRIVATE DISPLAY NAME";
    const b = endpoint("host-b", "target");
    await connect(a.hostId, [a]); await connect(b.hostId, [b]);
    await send(a.agentId, b.agentId, { text: null, fromAgentId: "DECLARED SOURCE", conversation_id: "PRIVATE CONVERSATION" });
    const full = (await (await fetch(`${server.address}/native/messages?include_body=true`)).json()).messages;
    const metadata = JSON.parse(full[0].text.split("\n").at(-1));
    expect(metadata.source_agent_id).toBe(a.agentId.slice(0, 256));
    expect(Object.keys(metadata).sort()).toEqual(["reason", "recipient_agent_id", "source_agent_id", "source_harness"]);
    expect(full[0].text).not.toContain("PRIVATE");
    expect(full[0].text).not.toContain("DECLARED");
  });

  it("rejects unsupported WS send frames without trusting their source or target", async () => {
    const a = endpoint("host-a", "source"); const b = endpoint("host-b", "target");
    const sender = await connect(a.hostId, [a]); const receiver = await connect(b.hostId, [b]);
    sender.ws.send(JSON.stringify({ type: "native.send", to: b.agentId, from: a.agentId, text: null }));
    await expect.poll(() => sender.frames.some((frame) => frame.type === "native.error")).toBe(true);
    expect(receiver.deliveries()).toHaveLength(0);
    expect(await messages()).toHaveLength(0);
  });

  it("notifies about invalid payloads and durably deduplicates rejection retries", async () => {
    const a = endpoint("host-a", "source"); const b = endpoint("host-b", "target");
    await connect(a.hostId, [a]); await connect(b.hostId, [b]);
    const input = { text: { secret: "do-not-copy" }, idempotency_key: "rejected-op", extra: "do-not-copy" };
    const first = await send(a.agentId, b.agentId, input);
    expect(first).toMatchObject({ status: 400, body: { code: "invalid_payload", notification: "queued" } });
    expect((await send(a.agentId, b.agentId, input)).body.notification).toBe("deduplicated");
    expect(await messages()).toHaveLength(1);
    const full = (await (await fetch(`${server.address}/native/messages?include_body=true`)).json()).messages;
    expect(full[0].text).not.toContain("do-not-copy");
    // Also dedupe requests without a model-supplied operation ID.
    await send(a.agentId, b.agentId, { text: null });
    await send(a.agentId, b.agentId, { text: null });
    expect(await messages()).toHaveLength(2);
  });

  it("does not notify invalid targets, ambiguous names or unbound sources", async () => {
    const a = endpoint("host-a", "source"); const b = endpoint("host-b", "same");
    const c = endpoint("host-c", "same");
    await connect(a.hostId, [a]); await connect(b.hostId, [b]); await connect(c.hostId, [c]);
    for (const target of [null, 42, "", "x".repeat(513), "missing", "same"]) {
      expect((await send(a.agentId, target as string, { text: null })).body.notification).toBe("skipped");
    }
    expect((await send("unknown", b.agentId, { text: null, from: a.agentId })).body.notification).toBe("skipped");
    expect(await messages()).toHaveLength(0);
  });

  it("queues offline notices and preserves errors when notification storage fails", async () => {
    const a = endpoint("host-a", "source"); const b = endpoint("host-b", "target");
    await connect(a.hostId, [a]); const receiver = await connect(b.hostId, [b]);
    await receiver.register([{ ...b, reachable: false }]);
    expect((await send(a.agentId, b.agentId, { text: null })).body.notification).toBe("queued");
    expect(receiver.deliveries()).toHaveLength(0);
    vi.spyOn(ChannelStore.prototype, "acceptNative").mockImplementation(() => { throw new Error("synthetic storage failure"); });
    const result = await send(a.agentId, b.agentId, { text: "x".repeat(262145) });
    expect(result).toMatchObject({ status: 413, body: { actual_bytes: 262145, notification: "failed" } });
    expect(result.body.error).not.toContain("storage");
    vi.spyOn(ChannelStore.prototype, "nativeEndpoints").mockImplementation(() => { throw new Error("synthetic roster failure"); });
    const unavailable = await send(a.agentId, b.agentId, { text: "x".repeat(262145) });
    expect(unavailable).toMatchObject({ status: 413, body: { actual_bytes: 262145, notification: "skipped" } });
  });

  it("bounds technical notices with existing durable recipient rate limits", async () => {
    const a = endpoint("host-a", "source"); const b = endpoint("host-b", "target");
    await connect(a.hostId, [a]); await connect(b.hostId, [b]);
    for (let index = 0; index < 30; index++) {
      expect((await send(a.agentId, b.agentId, { text: null, idempotency_key: `reject-${index}` })).body.notification).toBe("queued");
    }
    const limited = await send(a.agentId, b.agentId, { text: null, idempotency_key: "overflow" });
    expect(limited).toMatchObject({ status: 400, body: { notification: "failed", code: "invalid_payload" } });
    expect(await messages()).toHaveLength(30);
    expect((await send(a.agentId, b.agentId, { text: null, idempotency_key: "reject-0" })).body.notification).toBe("deduplicated");
  });

  it("rejects HTTP parser overflow without guessing text size or notifying a target", async () => {
    const a = endpoint("host-a", "source"); const b = endpoint("host-b", "target");
    await connect(a.hostId, [a]); await connect(b.hostId, [b]);
    const result = await send(a.agentId, b.agentId, { text: "x".repeat(2 * 1024 * 1024) });
    expect(result.status).toBe(413);
    expect(result.body.error).toContain("2 MiB parser limit");
    expect(result.body).not.toHaveProperty("actual_bytes");
    expect(await messages()).toHaveLength(0);
  });

  it("routes only to the recipient adapter across two logical hosts and hides message bodies", async () => {
    const a = endpoint("logical-host-a", "same-cwd-one");
    const b = endpoint("logical-host-b", "same-cwd-two");
    const sender = await connect(a.hostId, [a]);
    const receiver = await connect(b.hostId, [b]);
    const observer = await connect("observer", []);
    const result = await send(a.agentId, b.agentId, { idempotency_key: "op1" });
    expect(result.status).toBe(201);
    expect(result.body.state).toBe("accepted");
    await expect.poll(() => receiver.deliveries().length).toBe(1);
    expect(sender.deliveries()).toHaveLength(0);
    expect(observer.deliveries()).toHaveLength(0);
    const audit = new DatabaseSync(dbPath);
    const persisted = audit.prepare("SELECT attempted_at FROM channel_messages WHERE message_id = ?").get(result.body.messageId);
    expect(persisted?.attempted_at).toBeTypeOf("number");
    audit.close();
    expect((await messages())[0]).not.toHaveProperty("text");
    expect(result.body).not.toHaveProperty("text");
    const full = await (await fetch(`${server.address}/native/messages?include_body=true`)).json();
    expect(full.messages[0].text).toBe("synthetic content");
    receiver.ws.send(JSON.stringify({ type: "native.receipt", messageId: result.body.messageId, state: "runtime_accepted" }));
    await expect.poll(async () => (await messages())[0].state).toBe("runtime_accepted");
    const retry = await send(a.agentId, b.agentId, { idempotency_key: "op1" });
    expect(retry.status).toBe(200);
    expect(retry.body.messageId).toBe(result.body.messageId);
    expect(receiver.deliveries()).toHaveLength(1);
    expect((await send(a.agentId, b.agentId, { idempotency_key: "op1", text: "changed" })).status).toBe(409);
    expect((await send("unregistered", b.agentId)).status).toBe(400);
  });

  it("transports exactly 256 KiB with escaped JSON and rejects one extra UTF-8 byte", async () => {
    const a = endpoint("byte-host-a", "sender");
    const b = endpoint("byte-host-b", "receiver");
    await connect(a.hostId, [a]);
    const receiver = await connect(b.hostId, [b]);
    const text = "\u0001".repeat(256 * 1024);
    expect((await send(a.agentId, b.agentId, { text })).status).toBe(201);
    await expect.poll(() => receiver.deliveries().length).toBe(1);
    expect(receiver.deliveries()[0].message.text).toBe(text);
    expect((await send(a.agentId, b.agentId, { text: "ż".repeat(128 * 1024) + "x" })).status).toBe(413);
  });

  it("supports independent adapters and sessions on one host without cwd dedup or snapshot theft", async () => {
    const a = endpoint("one-host", "one");
    const b = endpoint("one-host", "two");
    const c = endpoint("one-host", "three");
    const first = await connect(a.hostId, [a], "adapter-a");
    const second = await connect(b.hostId, [b, c], "adapter-b");
    const sent = await send(a.agentId, c.agentId);
    await expect.poll(() => second.deliveries().length).toBe(1);
    expect(first.deliveries()).toHaveLength(0);
    second.ws.send(JSON.stringify({ type: "native.receipt", messageId: sent.body.messageId, state: "runtime_accepted" }));
    await first.register([]);
    const agents = (await (await fetch(`${server.address}/native/agents`)).json()).agents;
    expect(agents.map((agent: NativeEndpoint) => agent.agentId).sort()).toEqual([b.agentId, c.agentId].sort());
    first.ws.send(JSON.stringify({ type: "native.register", hostId: a.hostId, adapterId: "adapter-a", instanceId: "i1", endpoints: [b] }));
    await expect.poll(() => first.frames.some((frame) => frame.type === "native.error" && frame.error.includes("another adapter"))).toBe(true);
  });

  it("enforces busy policy and FIFO, with held receipts distinct from runtime acceptance", async () => {
    const a = endpoint("a", "sender");
    const b = endpoint("b", "busy", "active");
    await connect("a", [a]);
    const receiver = await connect("b", [b]);
    expect((await send(a.agentId, b.agentId, { delivery: "steer" })).status).toBe(409);
    const first = await send(a.agentId, b.agentId);
    const second = await send(a.agentId, b.agentId);
    expect(first.body.state).toBe("queued");
    expect(receiver.deliveries()).toHaveLength(0);
    await receiver.register([{ ...b, state: "idle" }]);
    await expect.poll(() => receiver.deliveries().length).toBe(1);
    expect(receiver.deliveries()[0]?.message.messageId).toBe(first.body.messageId);
    receiver.ws.send(JSON.stringify({ type: "native.receipt", messageId: first.body.messageId, state: "held" }));
    await expect.poll(async () => (await messages())[0].state).toBe("held");
    expect(receiver.deliveries()).toHaveLength(1);
    receiver.ws.send(JSON.stringify({ type: "native.receipt", messageId: first.body.messageId, state: "runtime_accepted" }));
    await expect.poll(() => receiver.deliveries().length).toBe(2);
    expect(receiver.deliveries()[1]?.message.messageId).toBe(second.body.messageId);
  });

  it("releases FIFO after held disconnect without replaying the held attempt", async () => {
    const a = endpoint("a", "sender");
    const b = endpoint("b", "receiver");
    await connect("a", [a]);
    const receiver = await connect("b", [b]);
    const first = await send(a.agentId, b.agentId);
    const second = await send(a.agentId, b.agentId);
    receiver.ws.send(JSON.stringify({ type: "native.receipt", messageId: first.body.messageId, state: "held" }));
    await expect.poll(async () => (await messages())[0].state).toBe("held");
    receiver.ws.close();
    await once(receiver.ws, "close");
    await expect.poll(async () => (await messages())[0].state).toBe("delivery_unknown");
    const reconnected = await connect("b", [{ ...b, instanceId: "i2" }]);
    await expect.poll(() => reconnected.deliveries().length).toBe(1);
    expect(reconnected.deliveries()[0]?.message.messageId).toBe(second.body.messageId);
  });

  it("releases FIFO after held TTL without replaying or accepting late receipts", async () => {
    const a = endpoint("a", "sender");
    const b = endpoint("b", "receiver");
    await connect("a", [a]);
    const receiver = await connect("b", [b]);
    const first = await send(a.agentId, b.agentId, { expires_in_seconds: 1 });
    const second = await send(a.agentId, b.agentId);
    receiver.ws.send(JSON.stringify({ type: "native.receipt", messageId: first.body.messageId, state: "held" }));
    await expect.poll(async () => (await messages())[0].state).toBe("held");
    vi.spyOn(Date, "now").mockReturnValue(first.body.expiresAt);
    receiver.ws.send(JSON.stringify({ type: "native.heartbeat", hostId: "b" }));
    await expect.poll(() => receiver.deliveries().length).toBe(2);
    expect(receiver.deliveries()[1]?.message.messageId).toBe(second.body.messageId);
    expect((await messages())[0].state).toBe("delivery_unknown");
    receiver.ws.send(JSON.stringify({ type: "native.receipt", messageId: first.body.messageId, state: "runtime_accepted" }));
    await expect.poll(() => receiver.frames.some((frame) => frame.type === "native.error")).toBe(true);
    expect((await messages())[0].state).toBe("delivery_unknown");
  });

  it("expires a stale adapter before timer dispatch and preserves queued work for reconnect", async () => {
    const a = endpoint("a", "sender");
    const b = endpoint("b", "receiver");
    await connect("a", [a]);
    const receiver = await connect("b", [b]);
    const first = await send(a.agentId, b.agentId);
    const second = await send(a.agentId, b.agentId);
    receiver.ws.send(JSON.stringify({ type: "native.receipt", messageId: first.body.messageId, state: "held" }));
    await expect.poll(async () => (await messages())[0].state).toBe("held");
    const closed = once(receiver.ws, "close");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    // Wait for the real maintenance timer; it must close the lease before dispatching.
    await closed;
    expect(receiver.deliveries()).toHaveLength(1);
    expect((await messages()).map((message: { state: string }) => message.state)).toEqual(["delivery_unknown", "queued"]);
    const reconnected = await connect("b", [{ ...b, instanceId: "i2" }]);
    await expect.poll(() => reconnected.deliveries().length).toBe(1);
    expect(reconnected.deliveries()[0]?.message.messageId).toBe(second.body.messageId);
  });

  it("keeps a removed session queue bound to that session and supports explicit busy steering", async () => {
    const a = endpoint("a", "sender");
    const b = endpoint("b", "old", "active");
    const c = { ...endpoint("b", "new", "active"), capabilities: { receiveIdle: true, receiveBusy: "steer" as const } };
    await connect("a", [a]);
    const receiver = await connect("b", [b]);
    const queued = await send(a.agentId, b.agentId);
    await receiver.register([c]);
    expect(receiver.deliveries()).toHaveLength(0);
    const steered = await send(a.agentId, c.agentId, { delivery: "steer" });
    await expect.poll(() => receiver.deliveries().length).toBe(1);
    expect(receiver.deliveries()[0]?.message.messageId).toBe(steered.body.messageId);
    expect(receiver.deliveries()[0]?.message.deliveryPolicy).toBe("steer");
    expect((await messages()).find((message: { messageId: string }) => message.messageId === queued.body.messageId).state).toBe("queued");
    await receiver.register([c, { ...b, state: "idle" }]);
    await expect.poll(() => receiver.deliveries().length).toBe(2);
    expect(receiver.deliveries()[1]?.message.messageId).toBe(queued.body.messageId);
  });

  it("requires explicit offline queue and never blindly replays interrupted delivery on reconnect or restart", async () => {
    const a = endpoint("a", "sender");
    const b = endpoint("b", "receiver");
    await connect("a", [a]);
    const receiver = await connect("b", [b]);
    const first = await send(a.agentId, b.agentId, { idempotency_key: "unknown-op" });
    await expect.poll(() => receiver.deliveries().length).toBe(1);
    receiver.ws.close();
    await once(receiver.ws, "close");
    await expect.poll(async () => (await messages())[0].state).toBe("delivery_unknown");
    expect((await send(a.agentId, b.agentId)).status).toBe(409);
    const queued = await send(a.agentId, b.agentId, { delivery: "queue", idempotency_key: "queue-op" });
    expect(queued.body.state).toBe("queued");
    await server.stop();
    server = new RegistryServer(0, { native: true, dbPath });
    await server.start();
    const reconnected = await connect("b", [{ ...b, instanceId: "i2" }]);
    await expect.poll(() => reconnected.deliveries().length).toBe(1);
    expect(reconnected.deliveries()[0]?.message.messageId).toBe(queued.body.messageId);
    const retry = await send(a.agentId, b.agentId, { idempotency_key: "unknown-op" });
    expect(retry.body.messageId).toBe(first.body.messageId);
    expect(retry.body.state).toBe("delivery_unknown");
    expect(reconnected.deliveries()).toHaveLength(1);
    await server.stop();
    server = new RegistryServer(0, { native: true, dbPath });
    await server.start();
    expect((await messages()).map((message: { state: string }) => message.state)).toEqual(["delivery_unknown", "delivery_unknown"]);
  });

  it("rejects legacy HTTP/WS and misrouted receipts without broadcasting content", async () => {
    const a = endpoint("a", "sender");
    const b = endpoint("b", "receiver");
    const sender = await connect("a", [a]);
    await connect("b", [b]);
    const sent = await send(a.agentId, b.agentId);
    sender.ws.send(JSON.stringify({ type: "native.receipt", messageId: sent.body.messageId, state: "runtime_accepted" }));
    sender.ws.send(JSON.stringify({ type: "agent.message", data: { toAgentId: b.agentId, text: "legacy" } }));
    await expect.poll(() => sender.frames.filter((frame) => frame.type === "native.error").length).toBe(2);
    expect((await messages())[0].state).toBe("accepted");
    for (const path of ["/agents", "/notify-claude", "/channel/messages", "/events", `/agents/${b.agentId}/message`]) {
      expect((await fetch(server.address + path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
    }
    expect((await fetch(`${server.address}/channel/conversations`)).status).toBe(404);
  });

  it("returns explicit pair rate limits without counting idempotent retries", async () => {
    const a = endpoint("a", "sender");
    const b = endpoint("b", "busy", "active");
    await connect("a", [a]);
    const receiver = await connect("b", [b]);
    const first = await send(a.agentId, b.agentId, { idempotency_key: "rate-retry" });
    for (let i = 1; i < 30; i++) expect((await send(a.agentId, b.agentId)).status).toBe(201);
    const limited = await send(a.agentId, b.agentId);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toContain("Pair rate limit");
    const retry = await send(a.agentId, b.agentId, { idempotency_key: "rate-retry" });
    expect(retry.status).toBe(200);
    expect(retry.body.messageId).toBe(first.body.messageId);
    expect(await messages()).toHaveLength(30);
    expect(receiver.deliveries()).toHaveLength(0);
  });

  it("surfaces database write errors as HTTP errors with no delivery or success ACK", async () => {
    const a = endpoint("a", "sender");
    const b = endpoint("b", "receiver");
    await connect("a", [a]);
    const receiver = await connect("b", [b]);
    const audit = new DatabaseSync(dbPath);
    audit.exec("CREATE TRIGGER reject_native_insert BEFORE INSERT ON channel_messages BEGIN SELECT RAISE(FAIL, 'Injected write failure'); END");
    expect((await send(a.agentId, b.agentId)).status).toBe(503);
    expect(receiver.deliveries()).toHaveLength(0);
    expect(await messages()).toHaveLength(0);
    audit.close();
  });

  it("returns explicit HTTP storage failures after losing the database and never recreates an empty replacement", async () => {
    const a = endpoint("a", "sender");
    await connect("a", [a]);
    renameSync(dbPath, `${dbPath}.lost`);
    expect((await fetch(`${server.address}/native/health`)).status).toBe(503);
    expect((await fetch(`${server.address}/native/messages`)).status).toBe(503);
    expect((await send(a.agentId, a.agentId)).status).toBe(503);
    expect(existsSync(dbPath)).toBe(false);
  });
});

describe("native ChannelStore durable queue", () => {
  let dir: string;
  let store: ChannelStore;
  beforeEach(() => {
    dir = mkdtempSync(join(scratch, "native-store-"));
    store = new ChannelStore(join(dir, "registry.sqlite"));
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  it("bounds FIFO at 100, expires deterministically, and retains terminal messages for 30 days", () => {
    const a = endpoint("a", "sender");
    const b = endpoint("b", "receiver");
    const now = 1_000_000;
    for (let i = 0; i < 100; i++) store.acceptNative({ ...a, agentId: `sender-${i}` }, NativeSendSchema.parse({ to: b.agentId, text: String(i), expires_in_seconds: 1 }), () => b, now);
    expect(() => store.acceptNative(a, NativeSendSchema.parse({ to: b.agentId, text: "overflow" }), () => b, now)).toThrow(/full/);
    expect(store.nativeMessages().map((message) => message.text)).toEqual(Array.from({ length: 100 }, (_, i) => String(i)));
    store.maintainNative(now + 1000);
    expect(store.nativeMessages().every((message) => message.state === "expired")).toBe(true);
    store.maintainNative(now + 2 * 3600_000);
    expect(store.nativeMessages()).toHaveLength(100);
    store.maintainNative(now + 31 * 86400_000);
    expect(store.nativeMessages()).toHaveLength(0);
  });

  it("refuses startup with a missing known ledger and isolates native history from legacy cleanup", () => {
    const a = endpoint("a", "sender");
    const b = endpoint("b", "receiver");
    const message = store.acceptNative(a, NativeSendSchema.parse({ to: b.agentId, text: "retained" }), () => b, 1000).message;
    store.createMessage({ fromAgentId: "legacy", kind: "chat", content: "legacy", createdAt: 1000 });
    expect(store.deleteConversationsOlderThan(2000)).toBe(1);
    expect(store.nativeMessage(message.messageId)?.text).toBe("retained");
    expect(store.listConversations()).toHaveLength(0);
    const path = join(dir, "registry.sqlite");
    renameSync(path, `${path}.missing`);
    expect(() => new ChannelStore(path)).toThrow(/Storage lost/);
    expect(existsSync(path)).toBe(false);
  });

  it("records an interrupted attempt as unknown on startup without replaying it", () => {
    const a = endpoint("a", "sender");
    const b = endpoint("b", "receiver");
    const message = store.acceptNative(a, NativeSendSchema.parse({ to: b.agentId, text: "in flight" }), () => b).message;
    store.attemptNative(message.messageId, b.instanceId);
    store.close();
    store = new ChannelStore(join(dir, "registry.sqlite"));
    store.interruptNative();
    expect(store.nativeMessage(message.messageId)?.state).toBe("delivery_unknown");
    expect(store.attemptNative(message.messageId, "next-instance")).toBeUndefined();
  });

  it("deduplicates held and runtime receipts, rejects regressions, and expires held at the TTL boundary", () => {
    const a = endpoint("a", "sender");
    const b = endpoint("b", "receiver");
    const now = 1_000_000;
    const message = store.acceptNative(a, NativeSendSchema.parse({ to: b.agentId, text: "held", expires_in_seconds: 1 }), () => b, now).message;
    store.attemptNative(message.messageId, b.instanceId, now);
    expect(store.receiptNative(message.messageId, b.instanceId, "held", undefined, now).state).toBe("held");
    expect(store.receiptNative(message.messageId, b.instanceId, "held", undefined, now).state).toBe("held");
    expect(store.receiptNative(message.messageId, b.instanceId, "runtime_accepted", undefined, now).state).toBe("runtime_accepted");
    expect(store.receiptNative(message.messageId, b.instanceId, "runtime_accepted", undefined, now).state).toBe("runtime_accepted");
    expect(() => store.receiptNative(message.messageId, b.instanceId, "held", undefined, now)).toThrow(/conflicts/);
    const expiring = store.acceptNative(a, NativeSendSchema.parse({ to: b.agentId, text: "expires", expires_in_seconds: 1 }), () => b, now).message;
    store.attemptNative(expiring.messageId, b.instanceId, now);
    store.receiptNative(expiring.messageId, b.instanceId, "held", undefined, now);
    store.maintainNative(now + 999);
    expect(store.nativeMessage(expiring.messageId)?.state).toBe("held");
    expect(() => store.receiptNative(expiring.messageId, b.instanceId, "runtime_accepted", undefined, now + 1000)).toThrow(/conflicts/);
    expect(store.nativeMessage(expiring.messageId)?.state).toBe("delivery_unknown");
    expect(store.attemptNative(expiring.messageId, b.instanceId, now + 1000)).toBeUndefined();
    store.interruptNative();
    expect(store.nativeMessage(message.messageId)?.state).toBe("runtime_accepted");
  });

  it("keeps pair rate limits across restart, scopes independent pairs, and releases the 60-second window", () => {
    const a = endpoint("a", "sender"), b = endpoint("b", "receiver"), c = endpoint("c", "independent");
    const now = 1_000_000;
    const request = NativeSendSchema.parse({ to: b.agentId, text: "retry", idempotency_key: "rate-key" });
    const first = store.acceptNative(a, request, () => b, now).message;
    for (let i = 1; i < 30; i++) store.acceptNative(a, NativeSendSchema.parse({ to: b.agentId, text: String(i) }), () => b, now);
    store.close();
    store = new ChannelStore(join(dir, "registry.sqlite"));
    expect(store.acceptNative(a, request, () => b, now + 1).message.messageId).toBe(first.messageId);
    expect(() => store.acceptNative(a, NativeSendSchema.parse({ to: b.agentId, text: "limited" }), () => b, now + 59_999)).toThrow(/Pair rate limit/);
    expect(store.acceptNative(a, NativeSendSchema.parse({ to: c.agentId, text: "other pair" }), () => c, now + 1).created).toBe(true);
    expect(store.acceptNative(b, NativeSendSchema.parse({ to: a.agentId, text: "reverse pair" }), () => a, now + 1).created).toBe(true);
    expect(store.acceptNative(a, NativeSendSchema.parse({ to: b.agentId, text: "next window" }), () => b, now + 60_000).created).toBe(true);
  });

  it("backs up committed WAL data and restores messages, endpoints, receipts and the storage marker", () => {
    const a = endpoint("a", "sender"), b = endpoint("b", "receiver");
    store.saveNativeEndpoints([a, b], "adapter-key");
    const request = NativeSendSchema.parse({ to: b.agentId, text: "WAL history", idempotency_key: "backup-key" });
    const first = store.acceptNative(a, request, () => b).message;
    store.attemptNative(first.messageId, b.instanceId);
    store.receiptNative(first.messageId, b.instanceId, "runtime_accepted");
    store.createMessage({ messageId: "legacy-backup", fromAgentId: "legacy", kind: "chat", content: "legacy retained" });
    expect(existsSync(join(dir, "registry.sqlite-wal"))).toBe(true);
    const backup = store.backup(join(dir, "snapshot.sqlite"));
    expect(existsSync(backup.markerPath)).toBe(true);
    expect(() => store.backup(backup.dbPath)).toThrow(/already exists/);
    // Read before opening ChannelStore: no schema creation can conceal a bad snapshot.
    const inspection = new DatabaseSync(backup.dbPath, { readOnly: true });
    expect(inspection.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    expect(inspection.prepare("SELECT COUNT(*) AS count FROM channel_acks").get()?.count).toBe(2);
    inspection.close();
    const restored = new ChannelStore(backup.dbPath);
    try {
      expect(restored.nativeMessage(first.messageId)?.state).toBe("runtime_accepted");
      expect(restored.nativeMessage(first.messageId)?.text).toBe("WAL history");
      expect(restored.getMessage("legacy-backup")?.content).toBe("legacy retained");
      expect(restored.nativeEndpoints()).toHaveLength(2);
      expect(restored.nativeAdapterKey(b.agentId)).toBe("adapter-key");
      expect(restored.acceptNative(a, request, () => b).created).toBe(false);
    } finally { restored.close(); }
    renameSync(backup.dbPath, `${backup.dbPath}.lost`);
    expect(() => new ChannelStore(backup.dbPath)).toThrow(/Storage lost/);
    expect(existsSync(backup.dbPath)).toBe(false);
  });

  it("validates UTF-8 byte size and TTL, and persists correlated response as a separate message", () => {
    expect(NativeSendSchema.safeParse({ to: "b", text: "ą".repeat(131073) }).success).toBe(false);
    expect(NativeSendSchema.safeParse({ to: "b", text: "ok", expires_in_seconds: 86401 }).success).toBe(false);
    const a = endpoint("a", "sender");
    const b = endpoint("b", "receiver");
    const first = store.acceptNative(a, NativeSendSchema.parse({ to: b.agentId, text: "question" }), () => b).message;
    const second = store.acceptNative(b, NativeSendSchema.parse({ to: a.agentId, text: "answer", in_reply_to: first.messageId }), () => a).message;
    expect(second.conversationId).toBe(first.conversationId);
    expect(store.nativeMessage(first.messageId)?.state).toBe("responded");
    expect(store.nativeMessages()).toHaveLength(2);
  });
});
