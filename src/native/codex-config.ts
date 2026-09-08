import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface ConfigureCodexMcpOptions {
  configPath: string;
  cliPath: string;
  nodePath: string;
  brokerUrl: string;
  hostId: string;
  manifestDir: string;
}

interface CodexMcpManifest {
  schemaVersion: 1;
  configPath: string;
  existedBefore: boolean;
  beforeHash: string;
  afterHash: string;
  backupPath: string;
  managedBlock: string;
}

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const tomlString = (value: string) => JSON.stringify(value);

function block(options: ConfigureCodexMcpOptions): string {
  return `[mcp_servers.native_agent_broker]\ncommand = ${tomlString(options.nodePath)}\nargs = [${tomlString(options.cliPath)}, "mcp"]\n\n[mcp_servers.native_agent_broker.env]\nNAB_BROKER_URL = ${tomlString(options.brokerUrl)}\nNAB_HOST_ID = ${tomlString(options.hostId)}\n`;
}

function inspectToml(path: string): { valid: true; section: unknown } {
  const script = [
    "import json, pathlib, sys, tomllib",
    "data = tomllib.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))",
    "print(json.dumps({'valid': True, 'section': data.get('mcp_servers', {}).get('native_agent_broker')}))",
  ].join("\n");
  try { return JSON.parse(execFileSync("python3", ["-c", script, path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }
  catch { throw new Error("Codex TOML validation failed; configuration was not accepted"); }
}

async function readOptional(path: string): Promise<Buffer | null> {
  try { return await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path: string, contents: Buffer | string, mode: number) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.nab-${process.pid}-${Date.now()}`);
  await writeFile(temporary, contents, { mode });
  await rename(temporary, path);
}

export async function configureCodexMcp(options: ConfigureCodexMcpOptions): Promise<string> {
  const manifestPath = join(options.manifestDir, "codex-mcp.json");
  const desiredBlock = block(options);
  const desiredSection = {
    command: options.nodePath,
    args: [options.cliPath, "mcp"],
    env: { NAB_BROKER_URL: options.brokerUrl, NAB_HOST_ID: options.hostId },
  };
  const before = await readOptional(options.configPath);
  if (before === null) await atomicWrite(options.configPath, "", 0o600);
  let prior: CodexMcpManifest | null = null;
  try { prior = JSON.parse(await readFile(manifestPath, "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const inspected = inspectToml(options.configPath);
  if (inspected.section !== undefined && inspected.section !== null) {
    if (JSON.stringify(inspected.section) === JSON.stringify(desiredSection)) return manifestPath;
    if (!prior || !(await readFile(options.configPath, "utf8")).includes(prior.managedBlock)) {
      throw new Error("Codex native_agent_broker MCP configuration is not owned; refusing to replace it");
    }
  }

  let current = await readFile(options.configPath, "utf8");
  const original = prior && hash(current) === prior.afterHash ? await readFile(prior.backupPath)
    : prior && current.includes(prior.managedBlock) ? Buffer.from(current.replace(prior.managedBlock, ""))
    : before ?? Buffer.alloc(0);
  if (prior && current.includes(prior.managedBlock)) current = current.replace(prior.managedBlock, desiredBlock);
  else current = `${current}${current.length && !current.endsWith("\n") ? "\n" : ""}${current.length ? "\n" : ""}${desiredBlock}`;
  await atomicWrite(options.configPath, current, before ? (await stat(options.configPath)).mode & 0o777 : 0o600);
  inspectToml(options.configPath);

  await mkdir(options.manifestDir, { recursive: true, mode: 0o700 });
  const backupPath = join(options.manifestDir, "codex-config.toml.before");
  await writeFile(backupPath, original, { mode: 0o600 });
  await chmod(backupPath, 0o600);
  const manifest: CodexMcpManifest = {
    schemaVersion: 1, configPath: options.configPath, existedBefore: before !== null,
    beforeHash: hash(original), afterHash: hash(await readFile(options.configPath)), backupPath, managedBlock: desiredBlock,
  };
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  return manifestPath;
}

export async function rollbackCodexMcp(manifestPath: string): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CodexMcpManifest;
  const current = await readOptional(manifest.configPath);
  if (current === null || hash(current) !== manifest.afterHash) {
    throw new Error("Codex config changed after setup; refusing rollback");
  }
  const backup = await readFile(manifest.backupPath);
  if (hash(backup) !== manifest.beforeHash) throw new Error("Codex config backup hash mismatch");
  if (manifest.existedBefore) {
    const mode = (await stat(manifest.configPath)).mode & 0o777;
    await atomicWrite(manifest.configPath, backup, mode);
    inspectToml(manifest.configPath);
  } else await rm(manifest.configPath);
}
