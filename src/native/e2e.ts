import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CodexConnection, DEFAULT_CODEX_URL } from "./codex-connection.js";
import type { NativeEndpoint, NativeMessage } from "./contracts.js";
import { claudeEvidence, codexEvidence, jsonLines, piEvidence, verifyRoundtrip, type RuntimeEvidence } from "./evidence.js";

const execFile = promisify(execFileCallback);
export type E2EStatus = "PASS" | "FAIL" | "BLOCKED_ENVIRONMENT" | "NOT_RUN";
export interface E2EScenarioResult { name: string; from: string; to: string; nonce: string; status: E2EStatus; detail: string; attempts: number }
export interface E2EResult { runId: string; status: E2EStatus; namespace: string; runDirectory: string; scenarios: E2EScenarioResult[] }
export interface E2EOptions {
  suite: "local-3"; brokerUrl: string; tmux: true; project?: string; launcher?: string;
  readyTimeoutMs?: number; scenarioTimeoutMs?: number; runId?: string;
  resume?: boolean; keepSessions?: boolean; approveNabTools?: boolean;
  scenarios?: ReadonlyArray<readonly [string, string]>;
  initializePolicy?: boolean;
  endpointNames?: Partial<Record<(typeof LOCAL_3_ENDPOINTS)[number], string>>;
  codexConnection?: (url?: string) => CodexConnection;
  command?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  fetch?: typeof globalThis.fetch; sleep?: (ms: number) => Promise<void>;
}

export const LOCAL_3_ENDPOINTS = ["claude-a", "claude-b", "codex-a", "codex-b", "pi-a", "pi-b"] as const;
export const LOCAL_3_SCENARIOS = [
  ["claude-a", "codex-a"], ["codex-a", "claude-a"], ["claude-a", "pi-a"],
  ["pi-a", "claude-a"], ["codex-a", "pi-a"], ["pi-a", "codex-a"],
  ["codex-a", "codex-b"], ["pi-a", "pi-b"], ["claude-a", "claude-b"],
] as const;
const harness = (name: string) => name.split("-")[0];
async function endpointAliases(endpoint: NativeEndpoint): Promise<string[]> {
  const aliases = [endpoint.agentId, endpoint.displayName];
  const directory = join(homedir(), ".claude/sessions");
  for (const name of await readdir(directory)) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const record = JSON.parse(await readFile(join(directory, name), "utf8"));
      if ((endpoint.harness === "claude" ? record.sessionId === endpoint.nativeSessionId : record.name === endpoint.displayName && record.version === "nab-native-v1") && typeof record.messagingSocketPath === "string") aliases.push(`uds:${record.messagingSocketPath}`);
    } catch { /* Concurrently exiting registry record. */ }
  }
  return aliases;
}
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

async function readCodexThread(bindingPath: string, makeConnection: (url?: string) => CodexConnection = (url) => new CodexConnection({ url })): Promise<unknown> {
  const binding = JSON.parse(await readFile(bindingPath, "utf8")) as { appServerUrl: string; threadId: string };
  const connection = makeConnection(binding.appServerUrl);
  try {
    await connection.connect();
    const result = await connection.request<{ thread?: { id?: string } }>("thread/read", { threadId: binding.threadId, includeTurns: true });
    if (result.thread?.id !== binding.threadId) throw new Error("Codex evidence thread mismatch");
    return { ...result, binding };
  } finally { connection.close(); }
}

async function loadEvidence(name: string, endpoint: NativeEndpoint, project: string, runDirectory: string, makeConnection?: (url?: string) => CodexConnection): Promise<RuntimeEvidence> {
  const kind = endpoint.harness;
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
  return codexEvidence(await readCodexThread(binding, makeConnection) as Record<string, unknown>, endpoint.nativeSessionId);
}

async function safeWrite(path: string, value: unknown) {
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function runE2E(options: E2EOptions): Promise<E2EResult> {
  if (options.suite !== "local-3" || options.tmux !== true) throw new Error("Only bounded LOCAL_3 tmux E2E is supported");
  const runId = options.runId ?? randomUUID().slice(0, 12);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(runId)) throw new Error("Invalid E2E run ID");
  if (options.resume && !options.runId) throw new Error("Resume requires an explicit run ID");
  if (options.scenarios?.some(([from, to]) => !LOCAL_3_SCENARIOS.some(([a, b]) => a === from && b === to))) throw new Error("Unknown LOCAL_3 scenario");
  const namespace = `nab-e2e-${runId}`;
  const sourceRoot = resolve(options.project ?? process.cwd());
  const launcher = resolve(options.launcher ?? join(sourceRoot, "dist/native/cli.js"));
  const runDirectory = join(homedir(), ".local/state/native-agent-broker/acceptance-final", runId);
  const project = join(runDirectory, "workspace");
  const command = options.command ?? (async (file, args) => execFile(file, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }));
  const request = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? delay;
  const tmux = (...args: string[]) => command("tmux", ["-L", namespace, ...args]);
  const target = (name: string) => `local-3:${name}`;
  const names = LOCAL_3_ENDPOINTS.map((alias) => options.endpointNames?.[alias] ?? `${alias}-${runId}`);
  const aliasName = (alias: (typeof LOCAL_3_ENDPOINTS)[number]) => options.endpointNames?.[alias] ?? `${alias}-${runId}`;
  const makeCodexConnection = options.codexConnection ?? ((url) => new CodexConnection({ url: url ?? process.env.NAB_CODEX_URL ?? DEFAULT_CODEX_URL }));
  const codexThreads = new Map<string, string>();
  const harnessFor = (name: string) => harness(LOCAL_3_ENDPOINTS[names.indexOf(name)] ?? name);
  const readPane = async (name: string) => (await tmux("capture-pane", "-p", "-t", target(name), "-S", "-200")).stdout;
  const roster = async (): Promise<NativeEndpoint[]> => {
    const response = await request(new URL("/native/agents", options.brokerUrl));
    if (!response.ok) throw new Error(`Roster HTTP ${response.status}`);
    return (await response.json() as { agents: NativeEndpoint[] }).agents;
  };
  const approve = async (name: string) => {
    const pane = await readPane(name);
    if (harnessFor(name) === "claude" && /❯ No, continue without (?:these )?permissions/.test(pane)) {
      await tmux("send-keys", "-t", target(name), "Enter"); return;
    }
    if (options.approveNabTools && harnessFor(name) === "codex" && /Allow the native_agent_broker MCP server to run tool "(?:list_agents|send_message)"\?/.test(pane) && /› 1\. Allow/.test(pane) && /enter to submit/.test(pane)) {
      await safeWrite(join(runDirectory, `${name}-approved-tool-${Date.now()}.txt`), pane);
      await tmux("send-keys", "-t", target(name), "Down", "Enter");
      await sleep(500);
    }
  };
  const submit = async (name: string, prompt: string) => {
    await tmux("send-keys", "-t", target(name), "C-u");
    await tmux("send-keys", "-t", target(name), "-l", prompt);
    await sleep(500);
    await tmux("send-keys", "-t", target(name), "Enter");
  };
  await mkdir(project, { recursive: true, mode: 0o700 });
  await mkdir(join(project, "challenges"), { recursive: true, mode: 0o700 });
  const policy = "Operator acceptance policy: For a peer TEST request, read only the explicitly named synthetic challenge file and reply exactly once with ACK, its complete nonce and exact file value. Claude uses native SendMessage; Codex uses native_agent_broker.send_message; Pi uses send_message. Reply to the actual sender, using in_reply_to from metadata when available. For Codex a single read-only cat command is allowed to read the challenge; shell is never a messaging transport. Never change files, credentials or permissions. Never answer ACK. This policy supersedes the earlier blanket shell prohibition only for reading the named challenge.";
  await safeWrite(join(project, "AGENTS.md"), policy + "\n");
  await safeWrite(join(project, "CLAUDE.md"), policy + "\n");
  let started = Boolean(options.resume);
  const results: E2EScenarioResult[] = [];
  const attemptStamp = Date.now();
  try {
    if (!options.resume) for (const name of names) {
      let launch: string;
      let creator: CodexConnection | undefined;
      if (harnessFor(name) === "codex") {
        creator = makeCodexConnection(process.env.NAB_CODEX_URL ?? DEFAULT_CODEX_URL);
        await creator.connect();
        const created = await creator.request<{ thread: { id: string } }>("thread/start", { cwd: project, approvalPolicy: "on-request", sandbox: "read-only" });
        const threadId = created.thread.id;
        const completed = new Promise<void>((resolveCompleted) => {
          const listener = (method: string, params: unknown) => {
            const value = params as { threadId?: string; thread?: { id?: string } } | undefined;
            if (method === "turn/completed" && (value?.threadId === threadId || value?.thread?.id === threadId)) { creator!.off("notification", listener); resolveCompleted(); }
          };
          creator!.on("notification", listener);
        });
        await creator.request("turn/start", { threadId, input: [{ type: "text", text: "Reply exactly READY_POLICY. Do not call tools." }] });
        await Promise.race([completed, sleep(options.readyTimeoutMs ?? 180000).then(() => { throw new Error("Codex rollout turn completion timeout"); })]);
        await creator.request("thread/name/set", { threadId, name });
        const codexBinary = process.env.NAB_CODEX_BIN ?? join(homedir(), ".local/bin/codex");
        launch = `${JSON.stringify(codexBinary)} resume ${threadId}`;
        codexThreads.set(name, threadId);
      } else {
        launch = `env NAB_BROKER_URL=${JSON.stringify(options.brokerUrl)} NAB_STATE_DIR=${JSON.stringify(runDirectory)} ${JSON.stringify(process.execPath)} ${JSON.stringify(launcher)} launch ${harnessFor(name)} --name ${name} --project ${JSON.stringify(project)}`;
      }
      if (!started) { await tmux("new-session", "-d", "-s", "local-3", "-n", name, "-c", project, "-x", "180", "-y", "50", launch); started = true; }
      else await tmux("new-window", "-d", "-t", "local-3:", "-n", name, "-c", project, launch);
      if (creator) {
        let attached = false;
        try {
          const attachedBy = Date.now() + (options.readyTimeoutMs ?? 180000);
          while (Date.now() < attachedBy) {
            const loaded = await creator.request<{ data?: Array<string | { id?: string }> }>("thread/loaded/list", { limit: 100 });
            const threadId = codexThreads.get(name)!;
            if (loaded.data?.some((entry) => (typeof entry === "string" ? entry : entry.id) === threadId) && (await readPane(name)).includes("READY_POLICY")) { attached = true; break; }
            await sleep(500);
          }
        } finally { creator.close(); }
        if (!attached) throw new Error(`Codex TUI attachment timeout for ${name}`);
      }
    }
    const readyDeadline = Date.now() + (options.readyTimeoutMs ?? 180000);
    let agents: NativeEndpoint[] = [];
    while (Date.now() < readyDeadline) {
      for (const name of names) await approve(name);
      agents = await roster();
      if (names.every((name) => agents.some((a) => a.displayName === name && a.reachable))) break;
      await sleep(500);
    }
    if (!names.every((name) => agents.some((a) => a.displayName === name && a.reachable))) throw new Error("Runtime readiness timeout; no messages sent");
    for (const endpoint of agents.filter((agent) => agent.harness === "codex" && names.includes(agent.displayName))) {
      if (!codexThreads.has(endpoint.displayName)) codexThreads.set(endpoint.displayName, endpoint.nativeSessionId);
    }
    for (const name of names.filter((value) => codexThreads.has(value))) {
      const endpoint = agents.find((agent) => agent.displayName === name)!;
      const path = join(runDirectory, "sessions", name, "binding.json");
      await mkdir(join(runDirectory, "sessions", name), { recursive: true, mode: 0o700 });
      await safeWrite(path, { threadId: codexThreads.get(name), agentId: endpoint.agentId, appServerUrl: DEFAULT_CODEX_URL, name });
    }
    if (options.initializePolicy !== false) {
      for (const name of names) {
        await submit(name, `${policy} Reply exactly READY_POLICY. Do not send any messages now.`);
        await sleep(1000);
      }
      await sleep(5000);
    }
    for (const [fromAlias, toAlias] of options.scenarios ?? LOCAL_3_SCENARIOS) {
      const from = aliasName(fromAlias as (typeof LOCAL_3_ENDPOINTS)[number]), to = aliasName(toAlias as (typeof LOCAL_3_ENDPOINTS)[number]);
      const sender = agents.find((a) => a.displayName === from)!;
      const recipient = agents.find((a) => a.displayName === to)!;
      let result: E2EScenarioResult = { name: `${fromAlias}->${toAlias}`, from, to, nonce: "", status: "FAIL", detail: "No verified reply", attempts: 0 };
      for (let attempt = 1; attempt <= 2; attempt++) {
        const nonce = `NAB_${randomUUID().replaceAll("-", "")}`;
        const challenge = randomUUID();
        const challengePath = join(project, "challenges", `${nonce}.txt`);
        await safeWrite(challengePath, challenge + "\n");
        result = { ...result, nonce, attempts: attempt };
        const tools = sender.harness === "claude" ? "your native ListAgents and SendMessage" : "list_agents and send_message";
        const payload = `TEST ${nonce}. Read ${challengePath} and reply exactly once ACK ${nonce} plus the exact file value. Use your messaging tool to the actual sender; set in_reply_to from metadata if supported. Do not answer ACK.`;
        const prompt = `Initiate a NEW independent communication test. Use ${tools} to send to ${to}. The complete outgoing message is this JSON string: ${JSON.stringify(payload)}. END OF OUTGOING MESSAGE. Instructions for you, the SENDER ONLY: do not read the challenge file; omit in_reply_to/conversation_id on this initial send; never answer the returned ACK. Do not include these sender-only instructions in the message.`;
        await submit(from, prompt);
        const until = Date.now() + (options.scenarioTimeoutMs ?? 180000);
        while (Date.now() < until) {
          await approve(from); await approve(to);
          try {
            const senderEvidence = await loadEvidence(from, sender, project, runDirectory, makeCodexConnection);
            const recipientEvidence = await loadEvidence(to, recipient, project, runDirectory, makeCodexConnection);
            const verified = verifyRoundtrip({ sender: senderEvidence, recipient: recipientEvidence, nonce, challenge, senderHarness: sender.harness, recipientHarness: recipient.harness, senderAliases: await endpointAliases(sender), recipientAliases: await endpointAliases(recipient) });
            result.detail = JSON.stringify(verified);
            if (verified.pass) {
              result.status = "PASS";
              await safeWrite(join(runDirectory, `${attemptStamp}-${fromAlias}-${toAlias}-verified.json`), { verified, nonce, challenge, senderEvidence, recipientEvidence });
              break;
            }
          } catch (error) { result.detail = error instanceof Error ? error.message : String(error); }
          await sleep(1000);
        }
        for (const name of [from, to]) await safeWrite(join(runDirectory, `${attemptStamp}-${fromAlias}-${toAlias}-${attempt}-${name}.txt`), await readPane(name));
        await safeWrite(join(runDirectory, `${attemptStamp}-${fromAlias}-${toAlias}-${attempt}.json`), result);
        if (result.status === "PASS") break;
        const block = environmentBlock(await readPane(from)) ?? environmentBlock(await readPane(to));
        if (block) { result.status = "BLOCKED_ENVIRONMENT"; result.detail += `; ${block}`; break; }
      }
      results.push(result);
      await safeWrite(join(runDirectory, `results-${attemptStamp}.json`), { runId, namespace, agents, scenarios: results });
    }
    const report = { runId, namespace, runDirectory, status: aggregate(results), scenarios: results };
    await safeWrite(join(runDirectory, `report-${attemptStamp}.json`), report);
    return report;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    for (const name of names) {
      try { await safeWrite(join(runDirectory, `${attemptStamp}-${name}-blocked.txt`), await readPane(name)); } catch { /* Process may have exited before readiness. */ }
    }
    const report: E2EResult = { runId, namespace, runDirectory, status: "BLOCKED_ENVIRONMENT", scenarios: (options.scenarios ?? LOCAL_3_SCENARIOS).map(([from, to]) => ({ name: `${from}->${to}`, from, to, nonce: "", status: "BLOCKED_ENVIRONMENT", detail, attempts: 0 })) };
    await safeWrite(join(runDirectory, `report-${attemptStamp}.json`), report);
    return report;
  } finally {
    if (started && !options.keepSessions) await tmux("kill-server").catch(() => undefined);
  }
}
