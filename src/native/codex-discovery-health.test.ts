import { expect, it } from "vitest";
import { codexDiscoveryHealth, shouldNotifyCodexIdentity } from "./codex-discovery-health.js";
import type { NativeEndpoint } from "./contracts.js";

it("does not create an initialization turn for an unnamed presentation alias", () => {
  const nativeSessionId = "01a08248-43db-7a62-859b-cf5f972e35cb";
  expect(shouldNotifyCodexIdentity({ nativeSessionId, displayName: "codex-01a08248" })).toBe(false);
  expect(shouldNotifyCodexIdentity({ nativeSessionId, displayName: "reviewer" })).toBe(true);
});

it("reports a missing fresh thread even when another Codex is reachable", () => {
  const agents = [{ hostId: "host", harness: "codex", reachable: true, nativeSessionId: "old" }] as NativeEndpoint[];
  expect(codexDiscoveryHealth(["old", "fresh"], agents, "host")).toEqual({ healthy: false, loadedCount: 2, missingThreadIds: ["fresh"] });
  expect(codexDiscoveryHealth(["old"], agents, "host").healthy).toBe(true);
  expect(codexDiscoveryHealth(["old"], agents, "other-host").healthy).toBe(false);
});
