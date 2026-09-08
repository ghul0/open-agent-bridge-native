import { mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installServices, rollback, serviceStatus, setup } from "./install.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nab-install-"));
  const home = join(root, "home"); const sourceDir = join(root, "release");
  await mkdir(join(sourceDir, "dist/native"), { recursive: true });
  await mkdir(join(sourceDir, "node_modules"), { recursive: true });
  await writeFile(join(sourceDir, "dist/native/cli.js"), "console.log('fixture')\n");
  await writeFile(join(sourceDir, "dist/native/pi-nab-extension.js"), "export {}\n");
  return { root, home, sourceDir };
}

describe("native local installer", () => {
  it("creates a private release, config, launcher and loopback services", async () => {
    const f = await fixture();
    const result = await setup({ home: f.home, sourceDir: f.sourceDir, version: "1.2.3", nodePath: "/opt/node/bin/node", hostId: "host-a" });
    const configPath = join(f.home, ".config/native-agent-broker/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config).toMatchObject({ brokerUrl: "http://127.0.0.1:4998", hostId: "host-a" });
    expect(config).not.toHaveProperty("token");
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    const wrapper = await readFile(join(f.home, ".local/bin/oab-native"), "utf8");
    expect(wrapper).toContain("/opt/node/bin/node"); expect(wrapper).toContain("NAB_BROKER_URL");
    expect(await readdir(result.releaseDir)).toEqual(["dist", "node_modules"]);
    const services = await installServices({ home: f.home, manifestPath: result.manifestPath });
    expect(await readFile(services.unitPaths[0], "utf8")).toContain("--host 127.0.0.1");
    expect(await readFile(services.unitPaths[1], "utf8")).toContain("Restart=on-failure");
    expect(await serviceStatus({ home: f.home })).toEqual([
      { name: "nab-broker.service", installed: true }, { name: "nab-host.service", installed: true },
    ]);
  });

  it("refuses an existing release without its manifest", async () => {
    const f = await fixture(); const target = join(f.home, ".local/share/native-agent-broker/releases/1.0.0");
    await mkdir(target, { recursive: true }); await writeFile(join(target, "user-file"), "keep");
    await expect(setup({ home: f.home, sourceDir: f.sourceDir, version: "1.0.0" })).rejects.toThrow("Refusing to overwrite");
    expect(await readFile(join(target, "user-file"), "utf8")).toBe("keep");
  });

  it("rolls back unchanged owned files but preserves later edits", async () => {
    const f = await fixture(); const result = await setup({ home: f.home, sourceDir: f.sourceDir, version: "2.0.0" });
    await installServices({ home: f.home, manifestPath: result.manifestPath });
    const launcher = join(f.home, ".local/bin/oab-native"); await writeFile(launcher, "user changed this\n");
    const outcome = await rollback(result.manifestPath);
    expect(outcome.preserved).toContain(launcher);
    expect(await readFile(launcher, "utf8")).toBe("user changed this\n");
    await expect(stat(result.releaseDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects incomplete release sources and non-loopback services", async () => {
    const f = await fixture(); await mkdir(join(f.root, "bad"));
    await expect(setup({ home: f.home, sourceDir: join(f.root, "bad"), version: "x" })).rejects.toThrow("dist");
    const result = await setup({ home: f.home, sourceDir: f.sourceDir, version: "x" });
    await expect(installServices({ home: f.home, manifestPath: result.manifestPath, brokerUrl: "http://0.0.0.0:4998" })).rejects.toThrow("loopback");
  });

  it("dereferences pnpm-style links and excludes unrelated source files", async () => {
    const f = await fixture(); const store = join(f.sourceDir, "node_modules/.pnpm/pkg/node_modules/pkg");
    await mkdir(store, { recursive: true }); await writeFile(join(store, "index.js"), "export {}\n");
    await symlink(".pnpm/pkg/node_modules/pkg", join(f.sourceDir, "node_modules/pkg"));
    await mkdir(join(f.sourceDir, ".git")); await writeFile(join(f.sourceDir, "secret.txt"), "do not copy");
    const result = await setup({ home: f.home, sourceDir: f.sourceDir, version: "links" });
    expect(await readFile(join(result.releaseDir, "node_modules/pkg/index.js"), "utf8")).toBe("export {}\n");
    await expect(stat(join(result.releaseDir, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(result.releaseDir, "secret.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses unmanaged config, launcher and service units", async () => {
    for (const target of [".config/native-agent-broker/config.json", ".local/bin/oab-native"]) {
      const f = await fixture(); const path = join(f.home, target); await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, "user-owned\n");
      await expect(setup({ home: f.home, sourceDir: f.sourceDir, version: "owned" })).rejects.toThrow("Refusing to overwrite");
      expect(await readFile(path, "utf8")).toBe("user-owned\n");
    }
    const f = await fixture(); const result = await setup({ home: f.home, sourceDir: f.sourceDir, version: "units" });
    const unit = join(f.home, ".config/systemd/user/nab-broker.service"); await mkdir(join(unit, ".."), { recursive: true }); await writeFile(unit, "user unit\n");
    await expect(installServices({ home: f.home, manifestPath: result.manifestPath })).rejects.toThrow("Refusing to overwrite");
  });

  it("upgrades across versions and rollback restores the prior launcher and config", async () => {
    const f = await fixture(); await setup({ home: f.home, sourceDir: f.sourceDir, version: "v1", hostId: "first" });
    const launcher = join(f.home, ".local/bin/oab-native"), config = join(f.home, ".config/native-agent-broker/config.json");
    const oldLauncher = await readFile(launcher, "utf8"), oldConfig = await readFile(config, "utf8");
    const second = await setup({ home: f.home, sourceDir: f.sourceDir, version: "v2", hostId: "second" });
    await rollback(second.manifestPath);
    expect(await readFile(launcher, "utf8")).toBe(oldLauncher); expect(await readFile(config, "utf8")).toBe(oldConfig);
  });

  it("quotes systemd paths containing spaces and rejects newline host IDs", async () => {
    const f = await fixture(); f.home = join(f.root, "home with spaces");
    const result = await setup({ home: f.home, sourceDir: f.sourceDir, version: "spaces", hostId: "safe" });
    const services = await installServices({ home: f.home, manifestPath: result.manifestPath });
    expect(await readFile(services.unitPaths[0], "utf8")).toContain(`ExecStart=\"${join(f.home, ".local/bin/oab-native")}\" broker`);
    await expect(setup({ home: f.home, sourceDir: f.sourceDir, version: "bad-id", hostId: "bad\nvalue" })).rejects.toThrow("Invalid hostId");
  });

  it("keeps original ownership metadata across idempotent setup", async () => {
    const f = await fixture(); const first = await setup({ home: f.home, sourceDir: f.sourceDir, version: "repeat" });
    await setup({ home: f.home, sourceDir: f.sourceDir, version: "repeat" });
    const outcome = await rollback(first.manifestPath);
    expect(outcome.removed).toContain(first.releaseDir);
    await expect(stat(join(f.home, ".config/native-agent-broker/config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
