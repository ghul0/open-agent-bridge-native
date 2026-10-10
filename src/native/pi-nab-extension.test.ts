import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeSendSchema, type NativeEndpoint } from "./contracts.js";
import nabPiExtension, { allowedNames, buildRoster, deliveryMode, readRegistry, SEND_MESSAGE_SCHEMA } from "./pi-nab-extension.js";
import { HostLink, peerText, sendMessage } from "./host-link.js";
import type { NativeMessage } from "./contracts.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock("./host-link.js", async (original) => {
  const actual = await original<typeof import("./host-link.js")>();
  return { ...actual, sendMessage: vi.fn(actual.sendMessage) };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const SELF = "nab:host:pi:self";

function endpoint(overrides: Partial<NativeEndpoint> & Pick<NativeEndpoint, "agentId">): NativeEndpoint {
  return {
    hostId: "host", instanceId: "instance", harness: "pi", displayName: "peer",
    nativeSessionId: "session", state: "idle", reachable: true,
    capabilities: { receiveIdle: true, receiveBusy: "steer" },
    ...overrides,
  };
}

function registry(...names: string[]) {
  return new Map(names.map((name) => [`nab:host:pi:${name}`, { name, agentId: `nab:host:pi:${name}`, dir: `/home/x/agents/${name}` }]));
}

/** A registry where each agent's view is given explicitly. */
function scoped(views: Record<string, string[] | undefined>) {
  return new Map(Object.entries(views).map(([name, sees]) => [
    `nab:host:pi:${name}`,
    { name, agentId: `nab:host:pi:${name}`, dir: `/home/x/agents/${name}`, sees },
  ]));
}

describe("buildRoster", () => {
  it("derives working, idle and sleeping from the roster and the registry", () => {
    const rows = buildRoster(
      [endpoint({ agentId: "nab:host:pi:alpha", state: "active" }), endpoint({ agentId: "nab:host:pi:beta" })],
      registry("alpha", "beta", "gamma"),
      SELF,
    );
    expect(rows.map((row) => [row.name, row.state])).toEqual([["alpha", "working"], ["beta", "idle"], ["gamma", "sleeping"]]);
  });

  it("hides sessions that are not registered agents", () => {
    const rows = buildRoster(
      [endpoint({ agentId: "nab:host:claude:stranger", harness: "claude" }), endpoint({ agentId: "nab:host:pi:alpha" })],
      registry("alpha"),
      SELF,
    );
    expect(rows.map((row) => row.agentId)).toEqual(["nab:host:pi:alpha"]);
  });

  it("shows every reachable session when there is no registry", () => {
    const rows = buildRoster([endpoint({ agentId: "nab:host:claude:stranger", harness: "claude" })], undefined, SELF);
    expect(rows).toHaveLength(1);
  });

  it("shows nothing but sleeping agents when the registry is empty", () => {
    const rows = buildRoster([endpoint({ agentId: "nab:host:pi:alpha" })], new Map(), SELF);
    expect(rows).toEqual([]);
  });

  it("never lists the caller, awake or asleep", () => {
    const rows = buildRoster([endpoint({ agentId: SELF })], registry("self"), SELF);
    expect(rows.find((row) => row.agentId === SELF)).toBeUndefined();
  });

  it("drops unreachable endpoints rather than reporting them as idle", () => {
    const rows = buildRoster([endpoint({ agentId: "nab:host:pi:alpha", reachable: false })], registry("alpha"), SELF);
    expect(rows).toEqual([{ name: "alpha", agentId: "nab:host:pi:alpha", state: "sleeping", harness: "pi" }]);
  });

  it("prefers the registry name over a stale displayName", () => {
    const rows = buildRoster([endpoint({ agentId: "nab:host:pi:alpha", displayName: "pi-agent" })], registry("alpha"), SELF);
    expect(rows[0]?.name).toBe("alpha");
  });
});

describe("per-agent visibility", () => {
  // The worked example: a sees b, c and d; b sees only a; c and d see a and
  // each other. Every view is asymmetric somewhere.
  const team = scoped({
    a: ["b", "c", "d"],
    b: ["a"],
    c: ["a", "d"],
    d: ["a", "c"],
  });
  const awake = ["a", "b", "c", "d"].map((name) => endpoint({ agentId: `nab:host:pi:${name}`, displayName: name }));
  const seenBy = (name: string) => buildRoster(awake, team, `nab:host:pi:${name}`).map((row) => row.name);

  it("gives each agent exactly the peers its list names", () => {
    expect(seenBy("a")).toEqual(["b", "c", "d"]);
    expect(seenBy("b")).toEqual(["a"]);
    expect(seenBy("c")).toEqual(["a", "d"]);
    expect(seenBy("d")).toEqual(["a", "c"]);
  });

  it("is directional: being seen does not grant sight", () => {
    expect(seenBy("a")).toContain("b");
    expect(seenBy("b")).not.toContain("c");
    expect(seenBy("b")).not.toContain("d");
  });

  it("hides a peer that is asleep just as it hides one that is awake", () => {
    expect(buildRoster([], team, "nab:host:pi:b").map((row) => row.name)).toEqual(["a"]);
  });

  it("shows sleeping peers that are allowed", () => {
    const rows = buildRoster([], team, "nab:host:pi:c");
    expect(rows.map((row) => [row.name, row.state])).toEqual([["a", "sleeping"], ["d", "sleeping"]]);
  });

  it("lets an agent with no list see every peer", () => {
    const mixed = scoped({ a: undefined, b: ["a"], c: ["a"] });
    const rows = buildRoster(awake.slice(0, 3), mixed, "nab:host:pi:a");
    expect(rows.map((row) => row.name)).toEqual(["b", "c"]);
  });

  it("ignores a named peer that is not registered", () => {
    const stale = scoped({ a: ["b", "departed"], b: ["a"] });
    expect(buildRoster(awake.slice(0, 2), stale, "nab:host:pi:a").map((row) => row.name)).toEqual(["b"]);
  });

  it("returns an empty view for an agent that may see nobody", () => {
    expect(buildRoster(awake, scoped({ a: [], b: ["a"] }), "nab:host:pi:a")).toEqual([]);
  });
});

describe("allowedNames", () => {
  it("is undefined when the agent has no list, so nothing is filtered", () => {
    expect(allowedNames(registry("a", "b"), "nab:host:pi:a")).toBeUndefined();
  });

  it("is undefined for a caller absent from the registry", () => {
    expect(allowedNames(scoped({ a: ["b"] }), "nab:host:pi:stranger")).toBeUndefined();
  });

  it("carries the names when a list is present", () => {
    expect(allowedNames(scoped({ a: ["b", "c"] }), "nab:host:pi:a")).toEqual(new Set(["b", "c"]));
  });
});

describe("readRegistry", () => {
  it("returns undefined when there is no registry, so the roster stays unfiltered", async () => {
    await expect(readRegistry(join(tmpdir(), "definitely-absent-registry.json"))).resolves.toBeUndefined();
  });

  it("returns an empty map for a corrupt registry rather than widening the roster", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nab-registry-"));
    const path = join(directory, "agents.json");
    await writeFile(path, "{ truncated");
    await expect(readRegistry(path)).resolves.toEqual(new Map());
  });

  it("keys entries by agentId and carries the name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nab-registry-"));
    const path = join(directory, "agents.json");
    await writeFile(path, JSON.stringify({ agents: { alpha: { agentId: "nab:host:pi:alpha", dir: "/home/x/agents/alpha", sees: ["beta"] } } }));
    const loaded = await readRegistry(path);
    expect(loaded?.get("nab:host:pi:alpha")?.name).toBe("alpha");
  });
});

describe("deliveryMode", () => {
  it("holds a queued message while the agent is mid-turn", () => {
    expect(deliveryMode({ deliveryPolicy: "queue" }, true)).toBe("followUp");
  });

  it("steers into an idle agent", () => {
    expect(deliveryMode({ deliveryPolicy: "queue" }, false)).toBe("steer");
    expect(deliveryMode({ deliveryPolicy: "auto" }, true)).toBe("steer");
  });
});

describe("peerText", () => {
  function message(overrides: Partial<NativeMessage>): NativeMessage {
    return {
      messageId: "m1", conversationId: "c1", fromAgentId: "nab:host:pi:sender",
      toAgentId: "nab:host:pi:recipient", text: "treść", expectsReply: false,
      deliveryPolicy: "auto", state: "accepted", createdAt: 0, expiresAt: 0,
      schemaVersion: 1, sourceInstanceId: "i1", deduplicated: false,
      ...overrides,
    } as NativeMessage;
  }

  it("warns that a peer's words are data, not authorization", () => {
    const text = peerText(message({}));
    expect(text).toContain("not operator authorization");
    expect(text).toContain("from_agent_id=nab:host:pi:sender");
    expect(text.endsWith("treść")).toBe(true);
  });

  it("marks a message a session sent to itself as coming from the system", () => {
    // The host injects briefings and notifications this way. Calling that a
    // peer message tells the model to distrust its own input and offers it a
    // reply address that loops back to itself — which is how one agent ended
    // up reasoning about "an echo of my own message".
    const text = peerText(message({ fromAgentId: "nab:host:pi:same", toAgentId: "nab:host:pi:same" }));
    expect(text).toMatch(/^\[system \d{2}\/\d{2} \d{2}:\d{2}\] treść$/);
    expect(text).not.toContain("from_agent_id");
    expect(text).not.toContain("send_message");
  });

  it("stamps the system line, because Pi never tells the model the time", () => {
    // A scheduled message read hours later — after a long turn, or in a
    // session resumed the next morning — otherwise looks like it just arrived.
    const at = Date.UTC(2026, 8, 22, 5, 7);
    const text = peerText(message({
      fromAgentId: "nab:host:pi:same", toAgentId: "nab:host:pi:same", createdAt: at,
    }));
    expect(text).toContain("22/09");
  });

  it("still treats a different sender on the same host as a peer", () => {
    const text = peerText(message({ fromAgentId: "nab:host:pi:a", toAgentId: "nab:host:pi:b" }));
    expect(text).toContain("NAB peer message");
  });
});


describe("UTF-8 message limits", () => {
  it("accepts exactly 256 KiB and rejects an extra byte", () => {
    const limit = 256 * 1024;
    expect(SEND_MESSAGE_SCHEMA.properties.text).not.toHaveProperty("maxLength");
    for (const text of ["a".repeat(limit), "ż".repeat(limit / 2), "😀".repeat(limit / 4)]) {
      expect(NativeSendSchema.parse({ to: SELF, text }).text).toBe(text);
      expect(() => NativeSendSchema.parse({ to: SELF, text: text + "x" })).toThrow("256 KiB");
    }
  });
});

describe("Pi rejection forwarding", () => {
  async function toolFixture() {
    vi.stubEnv("NAB_HOST_ID", "host");
    vi.spyOn(HostLink.prototype, "start").mockImplementation(() => {});
    type API = Parameters<typeof nabPiExtension>[0];
    const tools = new Map<string, Parameters<API["registerTool"]>[0]>();
    const events = new Map<string, Parameters<API["on"]>[1]>();
    nabPiExtension({ registerTool: (tool) => { tools.set(tool.name, tool); },
      sendMessage: () => {}, on: (name, handler) => { events.set(name, handler); } });
    const start = events.get("session_start");
    if (!start) throw new Error("Missing session handler");
    await start({}, { sessionManager: { getSessionId: () => "self", getEntries: () => [] }, ui: { setStatus: () => {} } });
    const tool = tools.get("send_message");
    if (!tool) throw new Error("Missing send tool");
    return tool;
  }
  it("forwards oversized text to the broker after permission checks and does not wake/retry on 413", async () => {
    const tool = await toolFixture();
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ agents: {
      self: { agentId: SELF, sees: ["peer"] }, peer: { agentId: "nab:host:pi:peer" },
    } }));
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error("Broker 413: Text exceeds 256 KiB UTF-8 limit (262144 bytes); actual size: 262145 bytes"));
    const text = "x".repeat(262145);
    await expect(tool.execute("call", { to: "nab:host:pi:peer", text })).rejects.toThrow("262145 bytes");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.any(String), SELF, expect.objectContaining({ text, to: "nab:host:pi:peer" }));
    vi.mocked(sendMessage).mockClear();
  });
  it("rejects an unauthorized target before forwarding even oversized text", async () => {
    const tool = await toolFixture();
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ agents: {
      self: { agentId: SELF, sees: [] }, peer: { agentId: "nab:host:pi:peer" },
    } }));
    await expect(tool.execute("call", { to: "nab:host:pi:peer", text: "x".repeat(262145) })).rejects.toThrow("not among the agents");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
