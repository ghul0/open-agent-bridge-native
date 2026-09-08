import { readdir, readFile, readlink } from "node:fs/promises";
import { basename } from "node:path";

export function codexProcessRole(args: string[], executable: string): "runtime" | "proxy" | undefined {
  if (basename(executable) !== "codex") return undefined;
  const index = args.indexOf("app-server");
  if (index < 0) return undefined;
  if (args[index + 1] === "proxy") return "proxy";
  if (["daemon", "generate-ts", "generate-json-schema", "help"].includes(args[index + 1])) return undefined;
  return "runtime";
}
export async function inspectCodexProcesses() {
  if (process.platform !== "linux") return { supported: false, runtimeCount: null, proxyCount: null, processes: [] };
  const rows: Array<{ pid: number; role: "runtime" | "proxy"; centralService: boolean }> = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const args = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0").filter(Boolean);
      const role = codexProcessRole(args, await readlink(`/proc/${entry}/exe`));
      if (!role) continue;
      const status = await readFile(`/proc/${entry}/status`, "utf8");
      const uid = status.match(/^Uid:\s+(\d+)/m)?.[1];
      if (Number(uid) !== process.getuid?.()) continue;
      rows.push({ pid: Number(entry), role, centralService: (await readFile(`/proc/${entry}/cgroup`, "utf8")).includes("/codex-app-server.service") });
    } catch { /* A process can exit during inspection. */ }
  }
  return { supported: true, runtimeCount: rows.filter((r) => r.role === "runtime").length, proxyCount: rows.filter((r) => r.role === "proxy").length, processes: rows };
}
