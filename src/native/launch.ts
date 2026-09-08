import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchManagedCodex } from "./codex-managed.js";

export async function launchHarness(harness: string, options: { name: string; project: string; brokerUrl: string; hostId: string; stateDir: string }) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.name)) throw new Error("Use a name containing letters, digits, hyphens or underscores");
  const project = resolve(options.project);
  await access(project);
  if (harness === "codex") {
    const result = await launchManagedCodex({ ...options, project, codexBinary: process.env.NAB_CODEX_BIN ?? join(homedir(), ".local/bin/codex") });
    process.exitCode = result.exitCode ?? 1; return;
  }
  const env = { ...process.env };
  delete env.CLAUDE_CODE_MESSAGING_TOKEN;
  delete env.CLAUDE_CODE_MESSAGING_SOCKET;
  delete env.CLAUDECODE;
  let command: string; let args: string[];
  if (harness === "claude") {
    command = process.env.NAB_CLAUDE_BIN ?? join(homedir(), ".local/bin/claude");
    args = ["--name", options.name];
  } else if (harness === "pi") {
    const root = process.env.NAB_PI_ROOT ?? join(homedir(), ".local/share/native-agent-broker/pi-clean");
    command = join(root, "node_modules/.bin/pi"); await access(command);
    env.PI_CODING_AGENT_DIR = join(root, "agent");
    env.PI_CODING_AGENT_SESSION_DIR = join(root, "sessions");
    env.NAB_BROKER_URL = options.brokerUrl; env.NAB_HOST_ID = options.hostId; env.NAB_AGENT_NAME = options.name;
    args = ["--no-extensions", "--extension", fileURLToPath(new URL("./pi-nab-extension.js", import.meta.url))];
  } else throw new Error("LOCAL_3 supports claude, codex and pi; Antigravity is outside MVP");
  const child = spawn(command, args, { cwd: project, stdio: "inherit", env });
  const stop = () => child.kill("SIGTERM"); process.once("SIGTERM", stop); process.once("SIGINT", stop);
  const code = await new Promise<number | null>((resolveExit, reject) => { child.once("exit", resolveExit); child.once("error", reject); });
  process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); process.exitCode = code ?? 1;
}
