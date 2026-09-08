import { describe, expect, it, vi } from "vitest";
import { ClaudeHost } from "./claude-host.js";

describe("Claude receipt lifecycle", () => {
  it("keeps held delivery pending for a later native receipt", async () => {
    const host = new ClaudeHost("http://127.0.0.1:1", "test");
    const receive = vi.spyOn(host.link, "receipt").mockImplementation(() => {});
    const resolve = vi.fn();
    const internal = host as unknown as { receipts: Map<string, unknown>; inbound(projection: unknown, frame: unknown): Promise<void> };
    internal.receipts.set("m", { resolve, timer: setTimeout(() => {}, 10000), address: "/private/receiver.sock", expiresAt: Date.now() + 10000 });
    const base = { msgV: 1, msg_id: "receipt", type: "control", action: "peer_message_status", orig_msg_id: "m", from: "uds:/private/receiver.sock" };
    await internal.inbound({}, { ...base, status: "held" });
    expect(receive).toHaveBeenCalledWith("m", "held", "Native peer hold");
    expect(resolve).not.toHaveBeenCalled();
    expect(internal.receipts.has("m")).toBe(true);
    await internal.inbound({}, { ...base, status: "delivered" });
    expect(resolve).toHaveBeenCalledWith("runtime_accepted");
    expect(internal.receipts.has("m")).toBe(false);
    host.stop();
  });
  it("ignores receipts from another address and resolves pending work on stop", async () => {
    const host = new ClaudeHost("http://127.0.0.1:1", "test");
    vi.spyOn(host.link, "receipt").mockImplementation(() => {});
    const resolve = vi.fn();
    const internal = host as unknown as { receipts: Map<string, unknown>; inbound(projection: unknown, frame: unknown): Promise<void> };
    internal.receipts.set("m", { resolve, timer: setTimeout(() => {}, 10000), address: "/private/expected.sock", expiresAt: Date.now() + 10000 });
    await internal.inbound({}, { type: "control", action: "peer_message_status", orig_msg_id: "m", from: "uds:/other.sock", status: "delivered" });
    expect(resolve).not.toHaveBeenCalled(); host.stop();
    expect(resolve).toHaveBeenCalledWith("delivery_unknown");
  });
});
