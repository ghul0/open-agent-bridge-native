import { EventEmitter } from "node:events";
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
  it("creates central Codex threads and resumes them without launching an app server", async () => {
    const commands: Array<{ file: string; args: string[] }> = [];
    const rpc: Array<{ method: string; params: unknown }> = [];
    let sequence = 0;
    class FakeCodexConnection extends EventEmitter {
      async connect() {}
      close() {}
      async request(method: string, params: unknown): Promise<any> {
        rpc.push({ method, params });
        if (method === "thread/start") return { thread: { id: `thread-${++sequence}` } };
        if (method === "turn/start") {
          const threadId = (params as { threadId: string }).threadId;
          queueMicrotask(() => this.emit("notification", "turn/completed", { thread: { id: threadId } }));
          return { turn: { id: `turn-${sequence}` } };
        }
        if (method === "thread/loaded/list") return { data: ["thread-1", "thread-2"] };
        return {};
      }
    }
    const names = { "codex-a": "nab-central-renamed", "codex-b": "nab-central-second" } as const;
    const allNames = ["claude-a-test-central", "claude-b-test-central", names["codex-a"], names["codex-b"], "pi-a-test-central", "pi-b-test-central"];
    const agents = allNames.map((displayName) => ({ ...endpoint(`agent-${displayName}`), displayName, harness: displayName.startsWith("nab-central") ? "codex" as const : displayName.startsWith("claude") ? "claude" as const : "pi" as const }));
    const result = await runE2E({
      suite: "local-3", tmux: true, brokerUrl: "http://127.0.0.1:4998", runId: "test-central",
      endpointNames: { "claude-a": allNames[0], "claude-b": allNames[1], ...names, "pi-a": allNames[4], "pi-b": allNames[5] },
      scenarios: [], initializePolicy: false, keepSessions: true,
      codexConnection: () => new FakeCodexConnection() as any,
      command: async (file, args) => { commands.push({ file, args }); return { stdout: args.includes("capture-pane") ? "READY_POLICY model output" : "", stderr: "" }; },
      fetch: async () => new Response(JSON.stringify({ agents }), { status: 200 }),
      sleep: async () => undefined,
    });
    expect(result.status).toBe("PASS");
    expect(commands.flatMap(({ args }) => args).join(" ")).not.toContain("app-server");
    const launches = commands.filter(({ args }) => args.includes("new-window") || args.includes("new-session")).flatMap(({ args }) => args);
    expect(launches.some((value) => value.endsWith("/.local/bin/codex\" resume thread-1"))).toBe(true);
    expect(launches.some((value) => value.endsWith("/.local/bin/codex\" resume thread-2"))).toBe(true);
    expect(launches).toContain("-c");
    expect(launches.join(" ")).not.toContain("--remote");
    expect(rpc.filter(({ method }) => method === "thread/loaded/list")).toHaveLength(2);
    expect(rpc.filter(({ method }) => method === "thread/start").every(({ params }) => (params as { approvalPolicy?: string }).approvalPolicy === "on-request")).toBe(true);
    expect(rpc.filter(({ method }) => method === "turn/start").every(({ params }) => !("tools" in (params as object)))).toBe(true);
  });

});
