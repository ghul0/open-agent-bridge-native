#!/usr/bin/env node
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setup, installServices, rollback } from "./install.js";
import { ChannelStore } from "../registry/channel-store.js";
import { runE2E } from "./e2e.js";
import { setupCleanPi } from "./pi-setup.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RegistryServer } from "../registry/server.js";
import { ClaudeHost } from "./claude-host.js";
import { brokerRequest } from "./host-link.js";
import { runNativeMcp } from "./mcp.js";
import { launchHarness } from "./launch.js";
import { CodexConnection, DEFAULT_CODEX_URL } from "./codex-connection.js";
import { inspectCodexProcesses } from "./codex-processes.js";
import { CodexHost } from "./codex-host.js";
import { configureCodexMcp, rollbackCodexMcp } from "./codex-config.js";

const stateDirectory = process.env.NAB_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "native-agent-broker");
const configDirectory = process.env.NAB_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "native-agent-broker");
const brokerUrl = process.env.NAB_BROKER_URL ?? "http://127.0.0.1:4998";
async function hostId() {
  if (process.env.NAB_HOST_ID) return process.env.NAB_HOST_ID;
  const filename = join(configDirectory, "host-id");
  try { return (await readFile(filename, "utf8")).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    const id = randomUUID(); await writeFile(filename, id, { flag: "wx", mode: 0o600 }); return id;
  }
}
const program = new Command("oab-native").description("Native Agent Broker — LOCAL_3").version("0.1.0");
program.command("setup").option("--local").option("--harnesses <names>", "LOCAL_3 harnesses", "claude,codex,pi").option("--release <release>", "Release identifier", "0.1.0-local3").action(async (options) => {
  if (options.harnesses.split(",").some((h: string) => !["claude", "codex", "pi"].includes(h))) throw new Error("Only LOCAL_3 harnesses are in this release");
  if (options.harnesses.split(",").includes("pi")) await setupCleanPi();
  console.log(JSON.stringify(await setup({ version: options.release, sourceDir: fileURLToPath(new URL("../../", import.meta.url)), brokerUrl, hostId: await hostId() }), null, 2));
});
const service = program.command("service");
service.command("install").option("--user").option("--start").option("--manifest <path>").action(async (options) => {
  const result = await installServices({ manifestPath: options.manifest });
  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  if (options.start) execFileSync("systemctl", ["--user", "enable", "--now", "nab-broker.service", "nab-host.service"], { stdio: "inherit" });
  console.log(JSON.stringify(result, null, 2));
});
for (const operation of ["status", "start", "stop", "restart"] as const) service.command(operation).action(() => {
  try { execFileSync("systemctl", ["--user", operation, "nab-broker.service", "nab-host.service", ...(operation === "status" ? ["--no-pager"] : [])], { stdio: "inherit" }); }
  catch { process.exitCode = 1; }
});
program.command("rollback").requiredOption("--manifest <path>").action(async (options) => {
  console.log(JSON.stringify(await rollback(options.manifest), null, 2));
});
program.command("uninstall").requiredOption("--manifest <path>").option("--keep-data").action(async (options) => {
  execFileSync("systemctl", ["--user", "disable", "--now", "nab-host.service", "nab-broker.service"], { stdio: "inherit" });
  console.log(JSON.stringify(await rollback(options.manifest), null, 2));
  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
});
program.command("broker").option("--port <number>", "Loopback port", "4998").option("--host <address>", "Trusted network bind address", "127.0.0.1").option("--db <path>").action(async (options) => {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const broker = new RegistryServer(Number(options.port), { native: true, dbPath: options.db ?? join(stateDirectory, "ledger.sqlite"), host: options.host });
  await broker.start();
  process.on("SIGTERM", async () => { await broker.stop(); process.exit(0); });
  process.on("SIGINT", async () => { await broker.stop(); process.exit(0); });
});
program.command("host").option("--claude-names <names>", "Restrict native discovery to explicit test names").option("--codex-threads <ids>", "Restrict shared Codex adapter to controlled test thread IDs").option("--no-codex", "Run only Claude native adapter").action(async (options) => {
  const id = await hostId();
  const host = new ClaudeHost(brokerUrl, id, options.claudeNames?.split(","));
  const central = options.codex ? new CodexHost({ brokerUrl, hostId: id, appServerUrl: process.env.NAB_CODEX_URL, threadIds: options.codexThreads?.split(",") }) : undefined;
  if (central) {
    const pending = new Set<string>();
    const confirmed = new Map<string, string>();
    central.link.onRoster = (agents) => {
      for (const agent of agents) {
        if (agent.harness !== "codex" || agent.hostId !== id || agent.instanceId !== central.link.instanceId || !agent.reachable || pending.has(agent.agentId) || confirmed.get(agent.agentId) === agent.displayName) continue;
        pending.add(agent.agentId);
        brokerRequest(brokerUrl, "/native/identity", agent.agentId, { name: agent.displayName }).then(() => confirmed.set(agent.agentId, agent.displayName)).catch((error) => central.link.onError(error)).finally(() => pending.delete(agent.agentId));
      }
    };
  }
  await host.start();
  try { await central?.start(); } catch (error) { host.stop(); central?.stop(); throw error; }
  const stop = () => { host.stop(); central?.stop(); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
});
program.command("mcp").action(runNativeMcp);
program.command("launch").argument("<harness>").requiredOption("--name <name>").requiredOption("--project <path>").action(async (harness, options) => {
  await launchHarness(harness, { ...options, brokerUrl, hostId: await hostId(), stateDir: join(stateDirectory, "sessions") });
});
const codex = program.command("codex").description("Operate on native threads in the existing central App Server; never spawn a server");
codex.command("migrate-bindings").requiredOption("--from <adapters>", "Comma-separated explicitly owned legacy adapter IDs").action(async (options) => {
  const id = await hostId();
  const store = new ChannelStore(join(stateDirectory, "ledger.sqlite"));
  try {
    const mapping = store.migrateNativeAdapterOwnership(id, options.from.split(","));
    const manifest = join(stateDirectory, `codex-binding-migration-${Date.now()}.json`);
    await writeFile(manifest, JSON.stringify(mapping, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ migrated: mapping.length, manifest }));
  } finally { store.close(); }
});
codex.command("rollback-bindings").requiredOption("--manifest <path>").action(async (options) => {
  const store = new ChannelStore(join(stateDirectory, "ledger.sqlite"));
  try { console.log(JSON.stringify({ restored: store.rollbackNativeAdapterOwnership(JSON.parse(await readFile(options.manifest, "utf8"))).length })); } finally { store.close(); }
});
codex.command("configure").action(async () => {
  const manifest = await configureCodexMcp({ configPath: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"), cliPath: fileURLToPath(import.meta.url), nodePath: process.execPath, brokerUrl, hostId: await hostId(), manifestDir: join(stateDirectory, "config-manifests") });
  const connection = new CodexConnection({ url: process.env.NAB_CODEX_URL ?? DEFAULT_CODEX_URL });
  try { await connection.connect(); await connection.request("config/mcpServer/reload", {}); console.log(JSON.stringify({ manifest, reloaded: true })); } finally { connection.close(); }
});
codex.command("rollback-config").requiredOption("--manifest <path>").action(async (options) => console.log(JSON.stringify(await rollbackCodexMcp(options.manifest))));
codex.command("status").action(async () => {
  const connection = new CodexConnection({ url: process.env.NAB_CODEX_URL ?? DEFAULT_CODEX_URL });
  try { await connection.connect(); console.log(JSON.stringify({ connected: true, loaded: await connection.request("thread/loaded/list", { limit: 100 }), processes: await inspectCodexProcesses() }, null, 2)); } finally { connection.close(); }
});
codex.command("rename").argument("<threadId>").argument("<name>").action(async (threadId, name) => {
  if (!name.trim() || name.length > 120 || /[\r\n]/.test(name)) throw new Error("Use a nonempty single-line thread name of at most 120 characters");
  const connection = new CodexConnection({ url: process.env.NAB_CODEX_URL ?? DEFAULT_CODEX_URL });
  try { await connection.connect(); await connection.request("thread/name/set", { threadId, name }); const view = await connection.request<{ thread: { id: string; name?: string } }>("thread/read", { threadId, includeTurns: false }); console.log(JSON.stringify({ threadId: view.thread.id, name: view.thread.name }, null, 2)); } finally { connection.close(); }
});
program.command("agents").option("--json").option("--include-offline").action(async (options) => {
  console.log(JSON.stringify(await brokerRequest(brokerUrl, `/native/agents?include_offline=${Boolean(options.includeOffline)}`), null, 2));
});
program.command("messages").option("--include-body").option("--agent <id>").option("--follow").action(async (options) => {
  const query = new URLSearchParams({ include_body: String(Boolean(options.includeBody)) });
  if (options.agent) query.set("agent", options.agent);
  const show = async () => console.log(JSON.stringify(await brokerRequest(brokerUrl, `/native/messages?${query}`), null, 2));
  await show(); if (options.follow) setInterval(() => show().catch((e) => console.error(e.message)), 2000);
});
program.command("doctor").option("--json").action(async () => {
  try {
    const health = await brokerRequest<Record<string, unknown>>(brokerUrl, "/native/health");
    const { agents } = await brokerRequest<{ agents: Array<{ harness: string; reachable: boolean }> }>(brokerUrl, "/native/agents");
    const missing = ["claude", "codex", "pi"].filter((h) => !agents.some((a) => a.harness === h && a.reachable));
    const codexProcesses = await inspectCodexProcesses();
    console.log(JSON.stringify({ ...health, missingHarnesses: missing, profile: "LOCAL_3_SHARED_CODEX", nativeLocalCapture: "not_enabled", codexProcesses, singletonEnforcement: "central service ownership; other native entry points are not globally blocked" }, null, 2));
    if (missing.length || health.ok === false || (codexProcesses.runtimeCount ?? 0) > 1) process.exitCode = 1;
  } catch (error) { console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Broker unreachable" })); process.exitCode = 1; }
});
program.command("backup").requiredOption("--to <path>").action(async (options) => {
  const store = new ChannelStore(join(stateDirectory, "ledger.sqlite"));
  try { console.log(JSON.stringify(store.backup(options.to), null, 2)); } finally { store.close(); }
});
program.command("e2e").option("--suite <name>", "Acceptance suite", "local-3").option("--tmux").option("--run-id <id>").option("--resume", "Resume this runner's existing test sessions").option("--keep-sessions", "Leave test sessions for bounded follow-up checks").option("--approve-nab-tools", "Operator consent for session-only NAB list/send in test Codex sessions").action(async (options) => {
  if (options.suite !== "local-3" || !options.tmux) throw new Error("Use e2e --suite local-3 --tmux");
  if (options.resume && !options.runId) throw new Error("--resume requires --run-id");
  const result = await runE2E({ suite: "local-3", tmux: true, brokerUrl, launcher: fileURLToPath(import.meta.url), runId: options.runId, resume: options.resume, keepSessions: options.keepSessions, approveNabTools: options.approveNabTools });
  console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === "PASS" ? 0 : result.status === "FAIL" ? 1 : 2;
});
program.command("capture").argument("<action>").action((action) => {
  if (action !== "status") throw new Error("Native capture is outside LOCAL_3; existing peers are not modified");
  console.log(JSON.stringify({ brokerTrafficCapture: "enabled_when_broker_running", nativeLocalClaudeCapture: "not_enabled", knownBypasses: ["direct Claude-to-Claude", "subagents", "teams", "cloud"] }, null, 2));
});
await program.parseAsync().catch((error) => { console.error(error instanceof Error ? error.message : "NAB command failed"); process.exitCode = 1; });
