import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NativeEndpoint } from "./contracts.js";
import { buildRoster, deliveryMode, readRegistry } from "./pi-nab-extension.js";

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
    await writeFile(path, JSON.stringify({ agents: { alpha: { agentId: "nab:host:pi:alpha", dir: "/home/x/agents/alpha" } } }));
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
