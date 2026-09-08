import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { rollback, setup } from "../native/install.js";
import { nativeAgentId, NativeSendSchema, type NativeEndpoint } from "../native/contracts.js";
import { ChannelStore } from "./channel-store.js";

const dirs: string[] = [];
function fixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `nab-${name}-`));
  dirs.push(dir);
  return dir;
}
function endpoint(hostId: string, session: string): NativeEndpoint {
  return { agentId: nativeAgentId(hostId, "pi", session), hostId, instanceId: "fixture-instance", harness: "pi", displayName: session,
    nativeSessionId: session, state: "idle", reachable: true, capabilities: { receiveIdle: true, receiveBusy: "queue" } };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("LOCAL_3 independent fault acceptance", () => {
  it("fails closed on real SQLite page exhaustion without accepting or losing prior history", () => {
    const dir = fixture("full-disk"), path = join(dir, "registry.sqlite");
    const store = new ChannelStore(path), sender = endpoint("host-a", "sender"), recipient = endpoint("host-b", "recipient");
    const first = store.acceptNative(sender, NativeSendSchema.parse({ to: recipient.agentId, text: "retained" }), () => recipient).message;
    const injector = new DatabaseSync(path);
    injector.exec("CREATE TABLE page_exhaustion(payload BLOB)");
    const pages = Number(injector.prepare("PRAGMA page_count").get()?.page_count);
    injector.exec(`PRAGMA max_page_count = ${pages}`);
    expect(() => injector.prepare("INSERT INTO page_exhaustion VALUES (zeroblob(1048576))").run()).toThrow(/full/i);
    let failed = false, countBeforeFailure = 0;
    for (let i = 0; i < 100 && !failed; i++) {
      countBeforeFailure = store.nativeMessages().length;
      try { store.acceptNative({ ...sender, agentId: `sender-${i}` }, NativeSendSchema.parse({ to: recipient.agentId, text: "x".repeat(32_768) }), () => recipient); }
      catch (error) { expect(String(error)).toMatch(/full/i); failed = true; }
    }
    expect(failed).toBe(true);
    expect(store.nativeMessages()).toHaveLength(countBeforeFailure);
    expect(store.nativeMessage(first.messageId)?.text).toBe("retained");
    expect(store.nativeMessage(first.messageId)?.state).toBe("queued");
    injector.close();
    store.close();
  });

  it("refuses a permissions-readonly ledger and does not replace it", () => {
    const dir = fixture("readonly"), path = join(dir, "registry.sqlite");
    const store = new ChannelStore(path);
    store.close();
    const before = readFileSync(path);
    chmodSync(path, 0o400);
    chmodSync(dir, 0o500);
    expect(() => new ChannelStore(path)).toThrow(/readonly|write|open/i);
    chmodSync(dir, 0o700);
    chmodSync(path, 0o600);
    expect(readFileSync(path)).toEqual(before);
  });

  it("refuses restart when the initialized database is missing", () => {
    const dir = fixture("missing"), path = join(dir, "registry.sqlite");
    const store = new ChannelStore(path);
    store.close();
    rmSync(path);
    expect(existsSync(`${path}.initialized`)).toBe(true);
    expect(() => new ChannelStore(path)).toThrow(/Storage lost/);
    expect(existsSync(path)).toBe(false);
  });

  it("installs, reinstalls and rolls back an actual isolated HOME without touching user state", async () => {
    const home = fixture("home");
    const sourceDir = fileURLToPath(new URL("../../", import.meta.url));
    const first = await setup({ home, sourceDir, version: "acceptance-release", hostId: "fixture-host" });
    expect(existsSync(join(first.releaseDir, "dist/native/cli.js"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, ".config/native-agent-broker/config.json"), "utf8")).hostId).toBe("fixture-host");
    const second = await setup({ home, sourceDir, version: "acceptance-release", hostId: "fixture-host" });
    expect(second.manifestPath).toBe(first.manifestPath);
    writeFileSync(join(home, ".local/bin/oab-native"), "foreign modification\n");
    const result = await rollback(first.manifestPath);
    expect(result.preserved).toContain(join(home, ".local/bin/oab-native"));
    expect(existsSync(first.releaseDir)).toBe(false);
  }, 120_000);
});
