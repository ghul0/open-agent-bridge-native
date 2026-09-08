import { describe, expect, it } from "vitest";
import { LOCAL_3_SCENARIOS, environmentBlock, scenarioEvidence, runE2E } from "./e2e.js";
import type { NativeEndpoint, NativeMessage } from "./contracts.js";

const endpoint = (agentId: string): NativeEndpoint => ({ agentId, hostId: "h", instanceId: "i", harness: "pi", displayName: agentId, nativeSessionId: agentId, state: "idle", reachable: true, capabilities: { receiveIdle: true, receiveBusy: "steer" } });
const message = (from: string, to: string, text: string, id: string, inReplyTo?: string): NativeMessage => ({ messageId: id, conversationId: "c", fromAgentId: from, toAgentId: to, sourceInstanceId: "i", text, createdAt: 1, expiresAt: 2, deliveryPolicy: "auto", expectsReply: false, inReplyTo, schemaVersion: 1, state: "runtime_accepted" });

describe("LOCAL_3 E2E helpers", () => {
  it("rejects an implicit resume and scenarios outside the controlled matrix", async () => {
    await expect(runE2E({ suite: "local-3", tmux: true, brokerUrl: "http://127.0.0.1:1", resume: true })).rejects.toThrow("explicit run ID");
    await expect(runE2E({ suite: "local-3", tmux: true, brokerUrl: "http://127.0.0.1:1", scenarios: [["foreign", "claude-a"]] })).rejects.toThrow("Unknown LOCAL_3 scenario");
  });
  it("defines exactly six cross, two diagonal and Claude control scenarios", () => {
    expect(LOCAL_3_SCENARIOS).toHaveLength(9);
    expect(new Set(LOCAL_3_SCENARIOS.map(([a, b]) => `${a.split("-")[0]}:${b.split("-")[0]}`))).toEqual(new Set(["claude:codex", "codex:claude", "claude:pi", "pi:claude", "codex:pi", "pi:codex", "codex:codex", "pi:pi", "claude:claude"]));
  });
  it("requires a correlated model reply, not an ack", () => {
    const a = endpoint("a"), b = endpoint("b"), request = message("a", "b", "nonce", "m1");
    expect(scenarioEvidence([request], a, b, "nonce").pass).toBe(false);
    expect(scenarioEvidence([request, message("b", "a", "nonce", "m2", "m1")], a, b, "nonce").pass).toBe(true);
    expect(scenarioEvidence([request, message("b", "a", "nonce", "m2", "wrong")], a, b, "nonce").pass).toBe(false);
  });
  it("allows Claude recipient ledger correlation without inReplyTo but not other harnesses", () => {
    const a = endpoint("a"), b = { ...endpoint("b"), harness: "claude" as const };
    const request = message("a", "b", "nonce", "m1");
    expect(scenarioEvidence([request, message("b", "a", "nonce", "m2")], a, b, "nonce").pass).toBe(true);
  });
  it("classifies approval and authentication gates as environment blocks", () => {
    expect(environmentBlock("MCP server requires user Allow approval")).toBeTruthy();
    expect(environmentBlock("Please sign in first")).toBeTruthy();
    expect(environmentBlock("ordinary model output")).toBeUndefined();
  });
});
