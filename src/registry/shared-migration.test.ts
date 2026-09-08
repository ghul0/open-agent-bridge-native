import { describe, expect, it } from "vitest";
import { nativeAgentId, type NativeEndpoint } from "../native/contracts.js";
import { ChannelStore } from "./channel-store.js";

function endpoint(hostId: string, harness: NativeEndpoint["harness"], session: string): NativeEndpoint {
  return {
    agentId: nativeAgentId(hostId, harness, session), hostId, instanceId: `${session}-instance`, harness,
    displayName: session, nativeSessionId: session, state: "idle", reachable: true,
    capabilities: { receiveIdle: true, receiveBusy: "steer" },
  };
}

describe("shared adapter ownership migration", () => {
  it("moves only matching Codex ownership and preserves endpoint identity and history", () => {
    const store = new ChannelStore(":memory:");
    const codex = endpoint("host-a", "codex", "thread-a");
    const otherHost = endpoint("host-b", "codex", "thread-b");
    const pi = endpoint("host-a", "pi", "pi-a");
    store.saveNativeEndpoints([codex], JSON.stringify(["host-a", "legacy-a"]));
    store.saveNativeEndpoints([otherHost], JSON.stringify(["host-b", "legacy-a"]));
    store.saveNativeEndpoints([pi], JSON.stringify(["host-a", "legacy-a"]));
    const sent = store.acceptNative(codex, { to: codex.agentId, text: "queued", delivery: "queue", expects_reply: false, expires_in_seconds: 600 }, () => codex);

    const mappings = store.migrateNativeAdapterOwnership("host-a", ["legacy-a"]);
    expect(mappings).toEqual([{
      agentId: codex.agentId,
      beforeAdapterId: JSON.stringify(["host-a", "legacy-a"]),
      afterAdapterId: JSON.stringify(["host-a", "codex-central"]),
    }]);
    expect(store.nativeAdapterKey(codex.agentId)).toBe(JSON.stringify(["host-a", "codex-central"]));
    expect(store.nativeAdapterKey(otherHost.agentId)).toBe(JSON.stringify(["host-b", "legacy-a"]));
    expect(store.nativeAdapterKey(pi.agentId)).toBe(JSON.stringify(["host-a", "legacy-a"]));
    expect(store.nativeEndpoints().find((item) => item.agentId === codex.agentId)).toEqual(codex);
    expect(store.nativeMessage(sent.message.messageId)).toEqual(sent.message);
    expect(store.migrateNativeAdapterOwnership("host-a", ["legacy-a"])).toEqual([]);
  });

  it("rolls back with compare-and-set and leaves future ownership unchanged", () => {
    const store = new ChannelStore(":memory:");
    const first = endpoint("host-a", "codex", "thread-a");
    const second = endpoint("host-a", "codex", "thread-b");
    store.saveNativeEndpoints([first, second], JSON.stringify(["host-a", "legacy-a"]));
    const mappings = store.migrateNativeAdapterOwnership("host-a", ["legacy-a"]);
    store.saveNativeEndpoints([second], JSON.stringify(["host-a", "future-adapter"]));

    expect(store.rollbackNativeAdapterOwnership(mappings)).toEqual([mappings[0]]);
    expect(store.nativeAdapterKey(first.agentId)).toBe(JSON.stringify(["host-a", "legacy-a"]));
    expect(store.nativeAdapterKey(second.agentId)).toBe(JSON.stringify(["host-a", "future-adapter"]));
  });

  it("atomically queues one identity notice per name revision", () => {
    const store = new ChannelStore(":memory:");
    const codex = endpoint("host-a", "codex", "thread-a");
    const first = store.claimNativeIdentity(codex, "worker");
    const duplicate = store.claimNativeIdentity(codex, "worker");
    const renamed = store.claimNativeIdentity(codex, "reviewer");

    expect(first).toMatchObject({ revision: 1, changed: true });
    expect(duplicate).toEqual({ revision: 1, changed: false });
    expect(renamed).toMatchObject({ revision: 2, changed: true });
    expect(store.nativeMessages()).toHaveLength(2);
    expect(renamed.message?.text).toContain(`agentId is ${codex.agentId}`);
  });
});
