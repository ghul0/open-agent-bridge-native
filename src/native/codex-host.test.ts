import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativeAgentId, type NativeMessage } from "./contracts.js";

const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
let connection: FakeConnection;
let link: FakeLink;

class FakeConnection extends EventEmitter {
  connected = true;
  close = vi.fn(() => { this.connected = false; });
  connect = vi.fn(async () => { this.connected = true; });
  request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    requests.push({ method, params });
    if (method === "thread/loaded/list") return { data: ["thread-a", "thread-b"], nextCursor: null };
    if (method === "thread/resume") return { thread: { id: params.threadId, name: params.threadId === "thread-a" ? "Alpha" : null, status: { type: "idle" }, updatedAt: 10 } };
    if (method === "thread/read") return { thread: { id: params.threadId, name: "Alpha", status: { type: "idle" }, turns: [] } };
    if (method === "turn/start") return { turn: { id: "turn-new" } };
    if (method === "thread/name/set") return {};
    return {};
  });
}
class FakeLink {
  instanceId = "instance";
  onDeliver: (message: NativeMessage) => Promise<void> = async () => {};
  onRoster: (agents: Array<{ instanceId: string; harness: string }>) => void = () => {};
  onError = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  update = vi.fn();
  receipt = vi.fn();
}
vi.mock("./codex-connection.js", async (original) => ({
  ...await original<typeof import("./codex-connection.js")>(),
  CodexConnection: class extends FakeConnection { constructor() { super(); connection = this; } },
}));
vi.mock("./host-link.js", async (original) => ({
  ...await original<typeof import("./host-link.js")>(),
  HostLink: class extends FakeLink { constructor() { super(); link = this; } },
}));

const { CodexHost } = await import("./codex-host.js");

function message(toAgentId: string, deliveryPolicy: "auto" | "queue" = "auto"): NativeMessage {
  return { messageId: "message-1", conversationId: "conversation-1", fromAgentId: "sender", toAgentId,
    sourceInstanceId: "source", text: "hello", createdAt: 1, expiresAt: 100, deliveryPolicy,
    expectsReply: false, schemaVersion: 1, state: "accepted" };
}

describe("CodexHost", () => {
  beforeEach(() => { requests.length = 0; vi.clearAllMocks(); });

  it("discovers loaded threads through resume and publishes central endpoints", async () => {
    const names = vi.fn();
    const host = new CodexHost({ brokerUrl: "http://broker", hostId: "host", threadIds: ["thread-a"], onName: names });
    await host.start();

    expect(requests.map((entry) => entry.method)).toEqual(["thread/loaded/list", "thread/resume"]);
    expect(link.start).toHaveBeenCalledOnce();
    expect(link.update).toHaveBeenLastCalledWith([expect.objectContaining({
      agentId: nativeAgentId("host", "codex", "thread-a"), displayName: "Alpha", state: "idle", reachable: true,
    })]);
    expect(host.currentEndpointIds()).toEqual([nativeAgentId("host", "codex", "thread-a")]);
    expect(names).not.toHaveBeenCalled();
    link.onRoster([link.update.mock.calls.at(-1)![0][0]]);
    expect(names).toHaveBeenCalledWith("thread-a", "Alpha");
    host.stop();
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("binds delivery to endpoint thread and starts only the idle thread", async () => {
    const host = new CodexHost({ brokerUrl: "http://broker", hostId: "host", threadIds: ["thread-a"] });
    await host.start();
    requests.length = 0;

    await link.onDeliver(message(nativeAgentId("host", "codex", "thread-a")));

    expect(requests.map((entry) => entry.method)).toEqual(["thread/read", "turn/start"]);
    expect(requests[0].params).toMatchObject({ threadId: "thread-a", includeTurns: true });
    expect(requests[1].params).toMatchObject({ threadId: "thread-a", clientUserMessageId: "message-1" });
    expect(link.receipt).toHaveBeenCalledWith("message-1", "runtime_accepted");
    host.stop();
  });

  it("observes approvals without responding and clears awaiting state on resolved", async () => {
    const host = new CodexHost({ brokerUrl: "http://broker", hostId: "host", threadIds: ["thread-a"] });
    await host.start();

    connection.emit("serverRequest", "approval-1", "item/commandExecution/requestApproval", { threadId: "thread-a" });
    expect(host.resolve("thread-a")?.state).toBe("awaiting_approval");
    expect(requests.some((entry) => entry.method === "response")).toBe(false);

    connection.emit("notification", "serverRequest/resolved", { requestId: "approval-1" });
    await vi.waitFor(() => expect(host.resolve("thread-a")?.state).toBe("idle"));
    host.stop();
  });

  it("maps native waiting flags without requiring a request replay", async () => {
    const host = new CodexHost({ brokerUrl: "http://broker", hostId: "host", threadIds: ["thread-a"] });
    await host.start();
    connection.emit("notification", "thread/status/changed", { threadId: "thread-a", status: { type: "active", activeFlags: ["waitingOnApproval"] } });
    expect(host.resolve("thread-a")?.state).toBe("awaiting_approval");
    connection.emit("notification", "thread/status/changed", { threadId: "thread-a", status: { type: "notLoaded" } });
    expect(link.update.mock.calls.at(-1)![0][0].reachable).toBe(false);
    host.stop();
  });
  it("serializes reconciliation and does not resubscribe known threads", async () => {
    const host = new CodexHost({ brokerUrl: "http://broker", hostId: "host", threadIds: ["thread-a"] });
    await host.start();
    connection.request.mockClear();
    let release!: (value: any) => void;
    connection.request.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const internal = host as unknown as { reconcile(): Promise<void> };
    const first = internal.reconcile();
    await internal.reconcile();
    expect(connection.request).toHaveBeenCalledTimes(1);
    release({ data: ["thread-a"], nextCursor: null });
    await first;
    expect(connection.request.mock.calls.map(([method]) => method)).toEqual(["thread/loaded/list", "thread/read"]);
    host.stop();
  });
  it("renames through native API and refreshes the snapshot", async () => {
    const host = new CodexHost({ brokerUrl: "http://broker", hostId: "host", threadIds: ["thread-a"] });
    await host.start();
    requests.length = 0;

    await host.rename("thread-a", "Reviewer");

    expect(requests).toEqual([
      { method: "thread/name/set", params: { threadId: "thread-a", name: "Reviewer" } },
      { method: "thread/read", params: { threadId: "thread-a", includeTurns: false } },
    ]);
    host.stop();
  });
});
