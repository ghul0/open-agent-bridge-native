import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface InstallPaths { home: string; dataDir: string; configDir: string; stateDir: string; binDir: string; unitDir: string; }
export interface SetupOptions { version: string; sourceDir: string; home?: string; nodePath?: string; brokerUrl?: string; hostId?: string; }
export interface ServiceOptions { home?: string; manifestPath?: string; brokerUrl?: string; hostId?: string; }
interface ManifestEntry { path: string; before: string | null; after: string; kind: "file" | "directory"; backupPath?: string; }
export interface InstallManifest { schemaVersion: 1; version: string; createdAt: string; entries: ManifestEntry[]; }

function paths(home = homedir()): InstallPaths { return { home, dataDir: join(home, ".local/share/native-agent-broker"), configDir: join(home, ".config/native-agent-broker"), stateDir: join(home, ".local/state/native-agent-broker"), binDir: join(home, ".local/bin"), unitDir: join(home, ".config/systemd/user") }; }
async function exists(path: string) { try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } }
async function hashPath(path: string): Promise<string | null> {
  if (!await exists(path)) return null;
  const stat = await lstat(path); const hash = createHash("sha256");
  if (stat.isSymbolicLink()) hash.update("link:").update(await readlink(path));
  else if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) hash.update(name).update((await hashPath(join(path, name))) ?? "");
  else hash.update(await readFile(path));
  return hash.digest("hex");
}
async function readJson<T>(path: string): Promise<T | null> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } }
function priorEntry(manifest: InstallManifest | null, path: string) { return manifest?.entries.find((entry) => entry.path === path); }
async function assertOwned(path: string, prior: ManifestEntry | undefined, label: string) {
  const current = await hashPath(path);
  if (current !== null && (!prior || current !== prior.after)) throw new Error(`Refusing to overwrite unmanaged or modified ${label}: ${path}`);
}
async function recordWrite(entries: ManifestEntry[], path: string, content: string, mode: number, prior?: ManifestEntry, backupDir?: string) {
  await assertOwned(path, prior, "file"); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let backupPath = prior?.backupPath;
  let before = prior?.before ?? null;
  if (prior && backupDir) { await mkdir(backupDir, { recursive: true, mode: 0o700 }); backupPath = join(backupDir, `${basename(path)}-${createHash("sha256").update(path).digest("hex").slice(0, 12)}`); await cp(path, backupPath); before = (await hashPath(backupPath))!; }
  await writeFile(path, content, { mode }); await chmod(path, mode);
  entries.push({ path, before, after: (await hashPath(path))!, kind: "file", backupPath });
}
async function findOwner(p: InstallPaths, path: string): Promise<ManifestEntry | undefined> {
  const dir = join(p.dataDir, "manifests"); if (!await exists(dir)) return undefined;
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".json")).sort().reverse()) {
    const manifest = await readJson<InstallManifest>(join(dir, name)); const entry = priorEntry(manifest, path);
    if (entry && await hashPath(path) === entry.after) return entry;
  }
  return undefined;
}
async function requireRelease(source: string) {
  for (const name of ["dist", "node_modules"]) { const target = join(source, name); if (!await exists(target) || !(await lstat(target)).isDirectory()) throw new Error(`Release source requires ${name}/`); }
  if (!await exists(join(source, "dist/native/cli.js"))) throw new Error("Release source requires dist/native/cli.js");
}
async function makeSelfContained(path: string, root: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) {
    const lexicalTarget = resolve(dirname(path), await readlink(path));
    if (lexicalTarget !== root && !lexicalTarget.startsWith(`${root}/`)) { await rm(path); return; }
    try { await realpath(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { await rm(path); return; } throw error; }
    return;
  }
  if (stat.isDirectory()) for (const name of await readdir(path)) await makeSelfContained(join(path, name), root);
}
async function copyRelease(source: string, target: string) {
  await mkdir(target, { recursive: true, mode: 0o700 });
  const optional = ["package.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "NOTICE"];
  await cp(join(source, "dist"), join(target, "dist"), { recursive: true, dereference: true });
  await cp(join(source, "node_modules"), join(target, "node_modules"), { recursive: true, dereference: false, verbatimSymlinks: true });
  for (const name of optional) if (await exists(join(source, name))) await cp(join(source, name), join(target, name), { dereference: true });
  const extensionSource = join(source, "src/native/pi-nab-extension.ts");
  if (await exists(extensionSource)) { const destination = join(target, "src/native/pi-nab-extension.ts"); await mkdir(dirname(destination), { recursive: true }); await cp(extensionSource, destination, { dereference: true }); }
  await makeSelfContained(target, await realpath(target));
}
function shellQuote(value: string) { return `'${value.replaceAll("'", `'\\''`)}'`; }

export async function setup(options: SetupOptions): Promise<{ manifestPath: string; releaseDir: string }> {
  if (!/^[A-Za-z0-9._-]+$/.test(options.version)) throw new Error("Invalid release version");
  const p = paths(options.home), source = resolve(options.sourceDir); await requireRelease(source);
  const releaseDir = join(p.dataDir, "releases", options.version), manifestPath = join(p.dataDir, "manifests", `${options.version}.json`);
  const prior = await readJson<InstallManifest>(manifestPath), releasePrior = priorEntry(prior, releaseDir); await assertOwned(releaseDir, releasePrior, "release");
  if (options.hostId?.includes("\n") || options.hostId?.includes("\r")) throw new Error("Invalid hostId");
  const configPath = join(p.configDir, "config.json"), launcherPath = join(p.binDir, "oab-native");
  const sameConfig = priorEntry(prior, configPath), sameLauncher = priorEntry(prior, launcherPath);
  const configPrior = sameConfig ?? await findOwner(p, configPath), launcherPrior = sameLauncher ?? await findOwner(p, launcherPath);
  await assertOwned(configPath, configPrior, "config"); await assertOwned(launcherPath, launcherPrior, "launcher");
  const oldConfig = configPrior ? await readJson<{ brokerUrl?: string; hostId?: string }>(configPath) : null;
  const stage = `${releaseDir}.stage-${randomUUID()}`; await mkdir(dirname(stage), { recursive: true, mode: 0o700 });
  try { await copyRelease(source, stage); if (await exists(releaseDir)) await rm(releaseDir, { recursive: true }); await rename(stage, releaseDir); } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
  const entries: ManifestEntry[] = [...(prior?.entries ?? []).filter((entry) => ![releaseDir, configPath, launcherPath].includes(entry.path)), { path: releaseDir, before: releasePrior?.before ?? null, after: (await hashPath(releaseDir))!, kind: "directory" }];
  const config = { brokerUrl: options.brokerUrl ?? oldConfig?.brokerUrl ?? "http://127.0.0.1:4998", hostId: options.hostId ?? oldConfig?.hostId ?? randomUUID(), paths: { release: releaseDir, state: p.stateDir, piExtension: join(releaseDir, "dist/native/pi-nab-extension.js") } };
  const backupDir = join(p.dataDir, "backups", options.version);
  await recordWrite(entries, configPath, `${JSON.stringify(config, null, 2)}\n`, 0o600, configPrior, sameConfig ? undefined : backupDir);
  const node = resolve(options.nodePath ?? process.execPath), configArg = shellQuote(configPath);
  const wrapper = `#!/bin/sh\nNODE=${shellQuote(node)}\nCONFIG=${configArg}\nif [ -r "$CONFIG" ]; then\n  export NAB_BROKER_URL="$("$NODE" -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).brokerUrl" "$CONFIG")"\n  export NAB_HOST_ID="$("$NODE" -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).hostId" "$CONFIG")"\nfi\nexport NAB_CONFIG_DIR=${shellQuote(p.configDir)} NAB_STATE_DIR=${shellQuote(p.stateDir)}\nexec "$NODE" ${shellQuote(join(releaseDir, "dist/native/cli.js"))} "$@"\n`;
  await recordWrite(entries, launcherPath, wrapper, 0o700, launcherPrior, sameLauncher ? undefined : backupDir);
  const manifest: InstallManifest = { schemaVersion: 1, version: options.version, createdAt: new Date().toISOString(), entries };
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 }); await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { manifestPath, releaseDir };
}

export async function installServices(options: ServiceOptions = {}): Promise<{ manifestPath: string; unitPaths: string[] }> {
  const p = paths(options.home); let manifestPath = options.manifestPath;
  if (!manifestPath) { const names = (await readdir(join(p.dataDir, "manifests"))).filter((name) => name.endsWith(".json")).sort(); if (!names.length) throw new Error("No install manifest found"); manifestPath = join(p.dataDir, "manifests", names.at(-1)!); }
  const manifest = await readJson<InstallManifest>(manifestPath); if (!manifest) throw new Error(`Manifest not found: ${manifestPath}`);
  const config = JSON.parse(await readFile(join(p.configDir, "config.json"), "utf8")) as { brokerUrl: string; hostId: string };
  const url = new URL(options.brokerUrl ?? config.brokerUrl); if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) throw new Error("Service setup requires a loopback broker URL");
  const hostId = options.hostId ?? config.hostId; if (/[\r\n"]/u.test(hostId)) throw new Error("Invalid hostId");
  const unitQuote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
  const env = `Environment=${unitQuote(`NAB_BROKER_URL=${url.toString()}`)}\nEnvironment=${unitQuote(`NAB_HOST_ID=${hostId}`)}\nEnvironment=${unitQuote(`NAB_CONFIG_DIR=${p.configDir}`)}\nEnvironment=${unitQuote(`NAB_STATE_DIR=${p.stateDir}`)}`;
  const service = `\n[Service]\nType=simple\nRestart=on-failure\nRestartSec=3s\n${env}\n`;
  const units = [
    ["nab-broker.service", `[Unit]\nAfter=network.target\nStartLimitIntervalSec=60\nStartLimitBurst=5\n${service}ExecStart=${unitQuote(join(p.binDir, "oab-native"))} broker --host 127.0.0.1 --port ${url.port || "4998"}\n\n[Install]\nWantedBy=default.target\n`],
    ["nab-host.service", `[Unit]\nAfter=network.target nab-broker.service codex-app-server.service\nRequires=nab-broker.service\nStartLimitIntervalSec=60\nStartLimitBurst=5\n${service}ExecStart=${unitQuote(join(p.binDir, "oab-native"))} host\n\n[Install]\nWantedBy=default.target\n`],
  ] as const;
  const unitPaths: string[] = [], retained = manifest.entries.filter((entry) => !units.some(([name]) => entry.path === join(p.unitDir, name)));
  for (const [name, body] of units) {
    const path = join(p.unitDir, name), same = priorEntry(manifest, path), owner = same ?? await findOwner(p, path);
    await recordWrite(retained, path, body, 0o600, owner, same ? undefined : join(p.dataDir, "backups", manifest.version)); unitPaths.push(path);
  }
  manifest.entries = retained; await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }); return { manifestPath, unitPaths };
}

export async function rollback(manifestPath: string): Promise<{ removed: string[]; preserved: string[] }> {
  const manifest = await readJson<InstallManifest>(manifestPath); if (!manifest) throw new Error(`Manifest not found: ${manifestPath}`);
  const removed: string[] = [], preserved: string[] = [];
  for (const entry of [...manifest.entries].reverse()) {
    if (await hashPath(entry.path) !== entry.after) { preserved.push(entry.path); continue; }
    if (entry.backupPath && await hashPath(entry.backupPath) === entry.before) { await cp(entry.backupPath, entry.path); await chmod(entry.path, entry.path.endsWith("oab-native") ? 0o700 : 0o600); removed.push(entry.path); continue; }
    if (entry.before !== null) { preserved.push(entry.path); continue; }
    await rm(entry.path, { recursive: entry.kind === "directory", force: true }); removed.push(entry.path);
  }
  return { removed, preserved };
}
export async function serviceStatus(options: { home?: string } = {}) { const p = paths(options.home); return Promise.all(["nab-broker.service", "nab-host.service"].map(async name => ({ name, installed: await exists(join(p.unitDir, name)) }))); }
export const installPaths = paths;
