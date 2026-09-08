import { describe, expect, it, vi } from "vitest";
import { nativeAgentId } from "./contracts.js";
import { resolveNativeMcpSender } from "./mcp.js";

const hostId = "central-host";
const threadId = "123e4567-e89b-42d3-a456-426614174000";
const agentId = nativeAgentId(hostId, "codex", threadId);
const endpoint = {
  agentId, hostId, instanceId: "central-instance", harness: "codex" as const,
  displayName: "worker", nativeSessionId: threadId, state: "idle" as const, reachable: true,
  capabilities: { receiveIdle: true, receiveBusy: "steer" as const },
};

function response(agents: unknown[]) {
  return vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({ agents }), { status: 200 }));
}

describe("resolveNativeMcpSender", () => {
  it("derives and validates the sender from request metadata", async () => {
    const fetchImpl = response([endpoint]);
    await expect(resolveNativeMcpSender({ _meta: { threadId } }, hostId, "http://broker.test", fetchImpl)).resolves.toBe(agentId);
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({ include_offline: "true", harness: "codex", query: agentId });
  });

  it.each([undefined, "", "not-a-uuid", "123E4567-E89B-42D3-A456-426614174000"])("fails closed for invalid metadata: %s", async (value) => {
    await expect(resolveNativeMcpSender({ _meta: value === undefined ? {} : { threadId: value } }, hostId, "http://broker.test", response([endpoint])))
      .rejects.toThrow("canonical _meta.threadId");
  });

  it("rejects an offline or mismatched registry response", async () => {
    await expect(resolveNativeMcpSender({ _meta: { threadId } }, hostId, "http://broker.test", response([{ ...endpoint, reachable: false }])))
      .rejects.toThrow("not registered as one reachable");
  });
});
