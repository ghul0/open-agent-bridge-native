// Framing and registry lifecycle derived from alonw0/pi-claude-link (MIT).
// Pinned source and full license: THIRD_PARTY_NOTICES.md.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface NativePeer {
  pid: number;
  sessionId: string;
  name: string;
  cwd: string;
  procStart: string;
  messagingSocketPath: string;
  status?: string;
  version?: string;
}
export interface WireFrame {
  msgV: 1;
  msg_id: string;
  type: "user" | "control";
  from?: string;
  message?: { role: "user"; content: string };
  action?: string;
  status?: string;
  orig_msg_id?: string;
  reason?: string;
  priority?: string;
}
export const registryDirectory = () => join(homedir(), ".claude", "sessions");
export const stripAddress = (address: string) => address.replace(/^uds:/, "");
export function processStart(pid: number): string {
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  }
  return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
}
export async function ownedPath(p: string, kind: "directory" | "socket" | "file") {
  const s = await lstat(p);
  if (s.isSymbolicLink() || s.uid !== process.getuid?.() || (kind === "directory" ? !s.isDirectory() : kind === "socket" ? !s.isSocket() : !s.isFile())) {
    throw new Error("Unsafe native path");
  }
  if (kind !== "file" && (s.mode & 0o022)) throw new Error("Native path is writable by another user");
  return s;
}
export async function livePeer(peer: NativePeer): Promise<boolean> {
  try {
    if (!Number.isSafeInteger(peer.pid) || peer.pid <= 0 || !peer.procStart || processStart(peer.pid) !== peer.procStart) return false;
    await ownedPath(dirname(peer.messagingSocketPath), "directory");
    await ownedPath(peer.messagingSocketPath, "socket");
    return await new Promise<boolean>((resolve) => {
      const c = connect(peer.messagingSocketPath);
      const done = (value: boolean) => { c.setTimeout(0); c.destroy(); resolve(value); };
      c.setTimeout(300, () => done(false));
      c.once("connect", () => done(true));
      c.once("error", () => done(false));
    });
  } catch { return false; }
}
export async function discoverNative(registry = registryDirectory()): Promise<NativePeer[]> {
  await ownedPath(registry, "directory");
  const peers: NativePeer[] = [];
  for (const f of await readdir(registry)) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      const filename = join(registry, f);
      await ownedPath(filename, "file");
      const p = JSON.parse(await readFile(filename, "utf8")) as NativePeer;
      if (p.version?.startsWith("nab-") || p.pid !== Number(f.slice(0, -5)) || typeof p.sessionId !== "string" || typeof p.name !== "string" || typeof p.messagingSocketPath !== "string") continue;
      if (await livePeer(p)) peers.push(p);
    } catch { /* A concurrently exiting peer is not reachable. */ }
  }
  return peers;
}
export function parseEnvelope(content: string): { text: string; from?: string } {
  const match = content.match(/^<cross-session-message((?:\s+[a-z-]+="[^"]*")*)>\n([\s\S]*)\n<\/cross-session-message>$/);
  if (!match) return { text: content };
  return { text: match[2].replace(/<\\\/cross-session-message/gi, "</cross-session-message"), from: match[1].match(/\sfrom="([^"]*)"/)?.[1] };
}
export function userFrame(from: string, name: string, text: string, id: string = randomUUID()): WireFrame {
  const safeName = name.replace(/["<>]/g, "");
  const safeFrom = from.replace(/["<>]/g, "");
  const body = text.replace(/<\/(?=cross-session-message(?:[>\s/]|$))/gi, "<\\/");
  return { msgV: 1, msg_id: id, type: "user", priority: "next", from: safeFrom,
    message: { role: "user", content: `<cross-session-message from="${safeFrom}" from-name="${safeName}">\n${body}\n</cross-session-message>` } };
}
export function sendFrame(address: string, frame: WireFrame): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(stripAddress(address));
    let writeStarted = false;
    socket.setTimeout(5000, () => socket.destroy(new Error("Native socket timeout")));
    socket.on("error", (error) => reject(Object.assign(error, { beforeWrite: !writeStarted })));
    socket.on("connect", () => { writeStarted = true; socket.end(`${JSON.stringify(frame)}\n`); });
    socket.on("close", (hadError) => { if (!hadError) resolve(); });
  });
}
export class LineDecoder {
  private pending = Buffer.alloc(0);
  constructor(private readonly onFrame: (f: WireFrame) => void, private readonly maxBytes = 2 * 1024 * 1024) {}
  push(chunk: Buffer) {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.indexOf(10) >= 0) {
      const index = this.pending.indexOf(10);
      if (index > this.maxBytes) throw new Error("Native frame too large");
      const line = this.pending.subarray(0, index).toString("utf8");
      this.pending = this.pending.subarray(index + 1);
      if (!line.trim()) continue;
      const f = JSON.parse(line) as WireFrame;
      if (f.msgV !== 1 || typeof f.msg_id !== "string" || !["user", "control"].includes(f.type)) throw new Error("Invalid native frame");
      if (f.type === "user" && (f.message?.role !== "user" || typeof f.message.content !== "string")) throw new Error("Invalid native message");
      this.onFrame(f);
    }
    if (this.pending.length > this.maxBytes) throw new Error("Native frame too large");
  }
}
export async function createProjection(options: { name: string; sessionId: string; socketDirectory: string; registry?: string; onFrame: (f: WireFrame) => void }) {
  const registry = options.registry ?? registryDirectory();
  await ownedPath(registry, "directory");
  await ownedPath(options.socketDirectory, "directory");
  const socketPath = join(options.socketDirectory, `nab-${process.pid}.sock`);
  const record = join(registry, `${process.pid}.json`);
  const server = createServer((c) => {
    const decoder = new LineDecoder(options.onFrame);
    c.setTimeout(10000, () => c.destroy());
    c.on("data", (chunk) => { try { decoder.push(chunk); } catch { c.destroy(); } });
    c.on("end", () => c.end());
    c.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  const entry = { pid: process.pid, sessionId: options.sessionId, name: options.name, cwd: process.cwd(), startedAt: Date.now(), procStart: processStart(process.pid), version: "nab-native-v1", peerProtocol: 1, kind: "interactive", entrypoint: "nab", nameSource: "derived", status: "idle", messagingSocketPath: socketPath };
  try { await writeFile(record, JSON.stringify(entry), { flag: "wx", mode: 0o600 }); }
  catch (error) { server.close(); await unlink(socketPath); throw error; }
  return { socketPath, async close() {
    try { const r = JSON.parse(await readFile(record, "utf8")); if (r.sessionId === entry.sessionId && r.procStart === entry.procStart && r.messagingSocketPath === socketPath) await unlink(record); } catch { /* Do not remove records owned by another generation. */ }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { await unlink(socketPath); } catch { /* The server may already have removed its socket. */ }
  } };
}
