import type { NativeEndpoint } from "./contracts.js";

export function shouldNotifyCodexIdentity(endpoint: Pick<NativeEndpoint, "displayName" | "nativeSessionId">): boolean {
  return endpoint.displayName !== `codex-${endpoint.nativeSessionId.slice(0, 8)}`;
}

export function codexDiscoveryHealth(loadedThreadIds: string[], agents: NativeEndpoint[], hostId: string) {
  const reachable = new Set(agents.filter((a) => a.hostId === hostId && a.harness === "codex" && a.reachable).map((a) => a.nativeSessionId));
  const missingThreadIds = loadedThreadIds.filter((id) => !reachable.has(id));
  return { healthy: missingThreadIds.length === 0, loadedCount: loadedThreadIds.length, missingThreadIds };
}
