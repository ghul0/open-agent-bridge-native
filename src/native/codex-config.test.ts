import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { configureCodexMcp, rollbackCodexMcp } from "./codex-config.js";

const roots: string[] = [];
async function fixture(content?: string) {
  const root = join(tmpdir(), `nab-codex-config-${randomUUID()}`);
  roots.push(root); await mkdir(root, { recursive: true });
  const configPath = join(root, "config.toml");
  if (content !== undefined) await writeFile(configPath, content, { mode: 0o640 });
  return { configPath, manifestDir: join(root, "manifests"), cliPath: "/opt/nab/oab-native.js", nodePath: "/usr/bin/node", brokerUrl: "http://127.0.0.1:4998", hostId: "host-a" };
}
afterEach(async () => { const { rm } = await import("node:fs/promises"); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("configureCodexMcp", () => {
  it("preserves unknown TOML, arrays, comments, and secrets byte-for-byte", async () => {
    const original = '# keep\nmodel = "gpt"\nsecret = "do-not-touch"\narr = [1, 2]\n\n[other]\nvalue = true\n';
    const options = await fixture(original);
    const manifest = await configureCodexMcp(options);
    const configured = await readFile(options.configPath, "utf8");
    expect(configured.startsWith(original)).toBe(true);
    expect(configured).toContain('[mcp_servers.native_agent_broker]\ncommand = "/usr/bin/node"');
    expect(configured).toContain('args = ["/opt/nab/oab-native.js", "mcp"]');
    expect(configured).toContain("NAB_HOST_ID = \"host-a\"");
    expect(configured).not.toContain("BINDING");
    expect((await stat(join(options.manifestDir, "codex-config.toml.before"))).mode & 0o777).toBe(0o600);
    await configureCodexMcp(options);
    expect(await readFile(options.configPath, "utf8")).toBe(configured);
    await rollbackCodexMcp(manifest);
    expect(await readFile(options.configPath, "utf8")).toBe(original);
    expect((await stat(options.configPath)).mode & 0o777).toBe(0o640);
  });

  it("updates only its exact prior managed block and keeps the original backup", async () => {
    const options = await fixture("x = 1\n");
    const manifest = await configureCodexMcp(options);
    await configureCodexMcp({ ...options, brokerUrl: "http://127.0.0.1:5999", hostId: "host-b" });
    const configured = await readFile(options.configPath, "utf8");
    expect(configured.match(/\[mcp_servers\.native_agent_broker\]/g)).toHaveLength(1);
    expect(configured).toContain("5999");
    await rollbackCodexMcp(manifest);
    expect(await readFile(options.configPath, "utf8")).toBe("x = 1\n");
  });

  it("rejects foreign sections, invalid TOML, and rollback after user changes", async () => {
    const foreign = await fixture('[mcp_servers.native_agent_broker]\ncommand = "foreign"\n');
    await expect(configureCodexMcp(foreign)).rejects.toThrow(/not owned/);
    const invalid = await fixture("not = [valid\n");
    expect(() => configureCodexMcp(invalid)).rejects.toThrow();
    const options = await fixture("x = 1\n");
    const manifest = await configureCodexMcp(options);
    await writeFile(options.configPath, `${await readFile(options.configPath, "utf8")}# user change\n`);
    await expect(rollbackCodexMcp(manifest)).rejects.toThrow(/changed after setup/);
  });

  it("preserves intervening unrelated edits when upgrading and rolling back", async () => {
    const options = await fixture('model = "gpt"\n');
    const manifest = await configureCodexMcp(options);
    await writeFile(options.configPath, `${await readFile(options.configPath, "utf8")}\n[other_client]\nkeep = true\n`);
    await configureCodexMcp({ ...options, cliPath: "/opt/nab/new-release.js" });
    await rollbackCodexMcp(manifest);
    const restored = await readFile(options.configPath, "utf8");
    expect(restored).toContain('[other_client]\nkeep = true');
    expect(restored).toContain('model = "gpt"');
    expect(restored).not.toContain('mcp_servers.native_agent_broker');
  });
  it("creates a private config and removes it on rollback", async () => {
    const options = await fixture();
    const manifest = await configureCodexMcp(options);
    expect((await stat(options.configPath)).mode & 0o777).toBe(0o600);
    await rollbackCodexMcp(manifest);
    await expect(stat(options.configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
