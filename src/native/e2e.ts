import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import type { NativeEndpoint, NativeMessage } from "./contracts.js";
import { claudeEvidence, codexEvidence, jsonLines, piEvidence, verifyRoundtrip, type RuntimeEvidence } from "./evidence.js";

const execFile = promisify(execFileCallback);
export type E2EStatus = "PASS" | "FAIL" | "BLOCKED_ENVIRONMENT" | "NOT_RUN";
export interface E2EScenarioResult { name: string; from: string; to: string; nonce: string; status: E2EStatus; detail: string; attempts: number }
export interface E2EResult { runId: string; status: E2EStatus; namespace: string; runDirectory: string; scenarios: E2EScenarioResult[] }
export interface E2EOptions {
  suite: "local-3"; brokerUrl: string; tmux: true; project?: string; launcher?: string;
  readyTimeoutMs?: number; scenarioTimeoutMs?: number; runId?: string;
  command?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  fetch?: typeof globalThis.fetch; sleep?: (ms: number) => Promise<void>;
}

export const LOCAL_3_SCENARIOS = [
  ["claude-a", "codex-a"], ["codex-a", "claude-a"], ["claude-a", "pi-a"],
  ["pi-a", "claude-a"], ["codex-a", "pi-a"], ["pi-a", "codex-a"],
  ["codex-a", "codex-b"], ["pi-a", "pi-b"], ["claude-a", "claude-b"],
] as const;
const harness = (name: string) => name.split("-")[0];
const endpointAliases = (endpoint: NativeEndpoint) => [endpoint.agentId, endpoint.displayName, endpoint.nativeSessionId];
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const aggregate = (items: E2EScenarioResult[]): E2EStatus => items.some((x) => x.status === "FAIL") ? "FAIL" : items.some((x) => x.status === "BLOCKED_ENVIRONMENT") ? "BLOCKED_ENVIRONMENT" : items.some((x) => x.status === "NOT_RUN") ? "NOT_RUN" : "PASS";

export function scenarioEvidence(messages: NativeMessage[], sender: NativeEndpoint, recipient: NativeEndpoint, nonce: string): { pass: boolean; detail: string } {
  const request = messages.find((m) => m.fromAgentId === sender.agentId && m.toAgentId === recipient.agentId && m.text.includes(nonce));
  if (!request) return { pass: false, detail: "No sender tool-call message in broker ledger" };
  // Native Claude SendMessage has no reliable inReplyTo. Exact participants + nonce are
  // only a ledger pre-check; the structured runtime oracle remains mandatory for PASS.
  const reply = messages.find((m) => m.fromAgentId === recipient.agentId && m.toAgentId === sender.agentId && m.text.includes(nonce) &&
    (recipient.harness === "claude" || m.inReplyTo === request.messageId));
  if (!reply) return { pass: false, detail: `No model challenge reply to ${request.messageId}` };
  return { pass: true, detail: `request=${request.messageId} reply=${reply.messageId}` };
}

export function environmentBlock(pane: string): string | undefined {
  const match = pane.match(/(requires? (?:approval|login|authentication)|not trusted|permission denied|MCP.+(?:Allow|approval)|sign in)/i);
  return match?.[0];
}

export function claudeProjectDirectory(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

async function readCodexThread(bindingPath: string): Promise<unknown> {
  const binding = JSON.parse(await readFile(bindingPath, "utf8")) as { appServerUrl: string; threadId: string };
  const ws = new WebSocket(binding.appServerUrl);
  let sequence = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id !== undefined && message.method) {
      ws.send(JSON.stringify({ id: message.id, error: { code: -32601, message: "Evidence collector never approves requests" } }));
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  await new Promise<void>((resolveOpen, reject) => { ws.once("open", resolveOpen); ws.once("error", reject); });
  const request = (method: string, params: unknown) => new Promise<any>((resolveRequest, rejectRequest) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); rejectRequest(new Error("Codex evidence RPC timeout")); }, 10_000);
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    await request("initialize", { clientInfo: { name: "nab-e2e-evidence", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: "initialized" }));
    const result = await request("thread/read", { threadId: binding.threadId, includeTurns: true });
    if (result.thread?.id !== binding.threadId) throw new Error("Codex evidence thread mismatch");
    return result;
  } finally { ws.close(); }
}

async function loadEvidence(name: string, endpoint: NativeEndpoint, project: string, runDirectory: string): Promise<RuntimeEvidence> {
  const kind = harness(name);
  if (kind === "claude") return claudeEvidence(await jsonLines(join(claudeProjectDirectory(project), `${endpoint.nativeSessionId}.jsonl`)), endpoint.nativeSessionId);
  if (kind === "pi") {
    const root = process.env.NAB_PI_ROOT ?? join(homedir(), ".local/share/native-agent-broker/pi-clean");
    const candidates = await readdir(join(root, "sessions"), { recursive: true });
    for (const candidate of candidates) if (candidate.endsWith(".jsonl")) {
      const rows = await jsonLines(join(root, "sessions", candidate));
      try { return piEvidence(rows, endpoint.nativeSessionId); } catch { /* Exact header mismatch: continue. */ }
    }
    throw new Error("Exact Pi session evidence not found");
  }
  const binding = join(runDirectory, "sessions", name, "binding.json");
  return codexEvidence(await readCodexThread(binding) as Record<string, unknown>, endpoint.nativeSessionId);
}

async function safeWrite(path: string, value: unknown) {
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function runE2E(options: E2EOptions): Promise<E2EResult> {
  if (options.suite !== "local-3" || options.tmux !== true) throw new Error("Only bounded LOCAL_3 tmux E2E is supported");
  const runId = options.runId ?? randomUUID().slice(0, 12);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(runId)) throw new Error("Invalid E2E run ID");
  const namespace = `nab-e2e-${runId}`;
  const sourceRoot = resolve(options.project ?? process.cwd());
  const launcher = resolve(options.launcher ?? join(sourceRoot, "dist/native/cli.js"));
  const runDirectory = join(homedir(), ".local/state/native-agent-broker/e2e", runId);
  const project = join(runDirectory, "workspace");
  const command = options.command ?? (async (file, args) => execFile(file, args, { encoding: "utf8", timeout: 15_000 }));
  const request = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? delay;
  await mkdir(runDirectory, { recursive: true, mode: 0o700 }); await chmod(runDirectory, 0o700);
  await mkdir(project, { recursive: true, mode: 0o700 });
  await mkdir(join(project, "challenges"), { mode: 0o700 });
  const aliases = ["claude-a", "claude-b", "codex-a", "codex-b", "pi-a", "pi-b"];
  const sessionName = (alias: string) => `${alias}-${runId}`;
  const sessions = aliases.map(sessionName);
  const tmux = (...args: string[]) => command("tmux", ["-L", namespace, ...args]);
  const tmuxSession = "local-3";
  const target = (name: string) => `${tmuxSession}:${name}`;
  let started = false;
  const panes: Record<string, string> = {};
  try {
    for (const name of sessions) {
      const challenge = randomUUID();
      await safeWrite(join(project, "challenges", `${name}.txt`), challenge + "\n");
      const launch = `env NAB_BROKER_URL=${JSON.stringify(options.brokerUrl)} NAB_STATE_DIR=${JSON.stringify(runDirectory)} ${JSON.stringify(process.execPath)} ${JSON.stringify(launcher)} launch ${harness(name)} --name ${name} --project ${JSON.stringify(project)}`;
      if (!started) { await tmux("new-session", "-d", "-s", tmuxSession, "-n", name, "-x", "180", "-y", "50", launch); started = true; }
      else await tmux("new-window", "-d", "-t", `${tmuxSession}:`, "-n", name, launch);
    }
    const deadline = Date.now() + (options.readyTimeoutMs ?? 90_000);
    let agents: NativeEndpoint[] = [];
    while (Date.now() < deadline) {
      try { agents = ((await (await request(new URL("/native/agents", options.brokerUrl))).json()) as { agents: NativeEndpoint[] }).agents; } catch { /* bounded retry */ }
      if (sessions.every((name) => agents.some((a) => a.displayName === name && a.reachable))) break;
      await sleep(500);
    }
    for (const name of sessions) {
      try { panes[name] = (await tmux("capture-pane", "-p", "-t", target(name), "-S", "-200")).stdout; } catch { panes[name] = ""; }
    }
    const missing = sessions.filter((name) => !agents.some((a) => a.displayName === name && a.reachable));
    if (missing.length) {
      const blocked = sessions.map((n) => environmentBlock(panes[n])).find(Boolean);
      const status: E2EStatus = blocked ? "BLOCKED_ENVIRONMENT" : "NOT_RUN";
      const scenarios = LOCAL_3_SCENARIOS.map(([from, to]) => ({ name: `${from}->${to}`, from, to, nonce: "", status, detail: blocked ?? `Ready checkpoint missing: ${missing.join(", ")}`, attempts: 0 }));
      await safeWrite(join(runDirectory, "manifest.json"), { runId, namespace, agents, scenarios });
      for (const [name, pane] of Object.entries(panes)) await safeWrite(join(runDirectory, `${name}.pane.txt`), pane);
      return { runId, status, namespace, runDirectory, scenarios };
    }
    const results: E2EScenarioResult[] = [];
    for (const [fromAlias, toAlias] of LOCAL_3_SCENARIOS) {
      const from = sessionName(fromAlias), to = sessionName(toAlias);
      let nonce = "";
      let result: E2EScenarioResult = { name: `${from}->${to}`, from, to, nonce, status: "FAIL", detail: "No verified reply", attempts: 0 };
      for (let attempt = 1; attempt <= 3; attempt++) {
        nonce = randomUUID();
        const challenge = randomUUID();
        result = { ...result, nonce, attempts: attempt };
        const challengePath = join(project, "challenges", `${to}.txt`);
        await safeWrite(challengePath, challenge + "\n");
        const senderHarness = harness(fromAlias);
        const prompt = senderHarness === "claude"
          ? `Use native ListAgents and SendMessage to ${to}. Include correlation nonce ${nonce}. Ask the recipient to read ${challengePath} and return both nonce and exact file content. Do not read the file yourself.`
          : `Use list_agents and send_message to ${to}. Include correlation nonce ${nonce}. Ask the recipient to read ${challengePath} and return both nonce and exact file content. Do not read the file yourself.`;
        await tmux("send-keys", "-t", target(from), "-l", prompt); await tmux("send-keys", "-t", target(from), "Enter");
        if (senderHarness === "claude" && harness(toAlias) === "claude") {
          await sleep(Math.min(options.scenarioTimeoutMs ?? 120_000, 15_000));
          const senderPane = (await tmux("capture-pane", "-p", "-t", target(from), "-S", "-300")).stdout;
          const recipientPane = (await tmux("capture-pane", "-p", "-t", target(to), "-S", "-300")).stdout;
          await safeWrite(join(runDirectory, `${from}-${to}-native-control-sender.pane.txt`), senderPane);
          await safeWrite(join(runDirectory, `${from}-${to}-native-control-recipient.pane.txt`), recipientPane);
          try {
            const senderEndpoint = agents.find((a) => a.displayName === from)!;
            const recipientEndpoint = agents.find((a) => a.displayName === to)!;
            const verified = verifyRoundtrip({
              sender: await loadEvidence(from, senderEndpoint, project, runDirectory),
              recipient: await loadEvidence(to, recipientEndpoint, project, runDirectory),
              nonce, challenge, senderHarness, recipientHarness: "claude",
              senderAliases: endpointAliases(senderEndpoint), recipientAliases: endpointAliases(recipientEndpoint),
            });
            result = { ...result, status: verified.pass ? "PASS" : "FAIL", detail: JSON.stringify(verified) };
          } catch (error) {
            result = { ...result, status: "NOT_RUN", detail: `Exact native evidence unavailable: ${error instanceof Error ? error.message : error}` };
          }
          break;
        }
        const until = Date.now() + (options.scenarioTimeoutMs ?? 120_000);
        while (Date.now() < until) {
          const response = await request(new URL("/native/messages?include_body=true", options.brokerUrl));
          const messages = ((await response.json()) as { messages: NativeMessage[] }).messages;
          const sender = agents.find((a) => a.displayName === from)!; const recipient = agents.find((a) => a.displayName === to)!;
          const evidence = scenarioEvidence(messages, sender, recipient, nonce);
          if (evidence.pass) {
            const senderPane = (await tmux("capture-pane", "-p", "-t", target(from), "-S", "-300")).stdout;
            const recipientPane = (await tmux("capture-pane", "-p", "-t", target(to), "-S", "-300")).stdout;
            await safeWrite(join(runDirectory, `${from}-${to}-sender.pane.txt`), senderPane);
            await safeWrite(join(runDirectory, `${from}-${to}-recipient.pane.txt`), recipientPane);
            try {
              const verified = verifyRoundtrip({
                sender: await loadEvidence(from, sender, project, runDirectory),
                recipient: await loadEvidence(to, recipient, project, runDirectory),
                nonce, challenge, senderHarness, recipientHarness: harness(toAlias),
              });
              result = { ...result, status: verified.pass ? "PASS" : "FAIL", detail: `${evidence.detail}; ${JSON.stringify(verified)}` };
            } catch (error) {
              result = { ...result, status: "NOT_RUN", detail: `${evidence.detail}; exact evidence unavailable: ${error instanceof Error ? error.message : error}` };
            }
            break;
          }
          await sleep(750);
        }
        const pane = (await tmux("capture-pane", "-p", "-t", target(from), "-S", "-300")).stdout;
        await safeWrite(join(runDirectory, `${from}-${to}-attempt-${attempt}.pane.txt`), pane);
        const block = environmentBlock(pane);
        if (block) { result = { ...result, status: "BLOCKED_ENVIRONMENT", detail: block }; break; }
        if (result.status === "PASS" || result.status === "NOT_RUN") break;
      }
      results.push(result);
    }
    const status = aggregate(results);
    await safeWrite(join(runDirectory, "manifest.json"), { runId, namespace, brokerUrl: options.brokerUrl, agents, scenarios: results });
    return { runId, status, namespace, runDirectory, scenarios: results };
  } finally {
    if (started) await tmux("kill-server").catch(() => undefined);
  }
}
