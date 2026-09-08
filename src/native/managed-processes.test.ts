import { EventEmitter, once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedProcesses } from "./managed-processes.js";

function child(): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
  const process = new EventEmitter() as ChildProcess & { kill: ReturnType<typeof vi.fn> };
  Object.assign(process, { exitCode: null, signalCode: null, kill: vi.fn(() => true) });
  return process;
}

const managers: ManagedProcesses[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.close(); vi.useRealTimers(); });

describe("ManagedProcesses", () => {
  it("terminates a real owned subprocess on parent signal and leaves a real foreign subprocess alive", async () => {
    const modulePath = fileURLToPath(new URL("./managed-processes.ts", import.meta.url));
    const childCode = "process.stdout.write(String(process.pid) + '\\n'); setInterval(() => {}, 1000)";
    const parentCode = `
      import { spawn } from "node:child_process";
      import { ManagedProcesses } from ${JSON.stringify(modulePath)};
      const manager = new ManagedProcesses();
      const owned = manager.add(spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: ["ignore", "pipe", "inherit"] }));
      owned.stdout.once("data", data => process.stdout.write("owned:" + data));
      process.once("SIGTERM", () => setTimeout(() => process.exit(0), 100));
      setInterval(() => {}, 1000);
    `;
    const foreign = spawn(process.execPath, ["-e", childCode], { stdio: ["ignore", "pipe", "inherit"] });
    const parent = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", parentCode], { stdio: ["ignore", "pipe", "inherit"] });
    try {
      const [foreignData] = await once(foreign.stdout!, "data");
      const [ownedData] = await once(parent.stdout!, "data");
      const foreignPid = Number(String(foreignData).trim());
      const ownedPid = Number(String(ownedData).trim().replace("owned:", ""));
      expect(foreignPid).toBe(foreign.pid);
      expect(ownedPid).not.toBe(parent.pid);
      parent.kill("SIGTERM");
      await once(parent, "exit");
      await expect.poll(() => { try { process.kill(ownedPid, 0); return true; } catch { return false; } }).toBe(false);
      expect(() => process.kill(foreignPid, 0)).not.toThrow();
      expect(foreign.exitCode).toBeNull();
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
      if (foreign.exitCode === null && foreign.signalCode === null) foreign.kill("SIGKILL");
      await Promise.all([parent, foreign].filter(child => child.exitCode === null && child.signalCode === null).map(child => once(child, "exit")));
    }
  }, 10_000);

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("terminates only owned children on %s", (signal) => {
    const manager = new ManagedProcesses(); managers.push(manager);
    const owned = child(), foreign = child();
    manager.add(owned);
    process.emit(signal);
    expect(owned.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(foreign.kill).not.toHaveBeenCalled();
  });

  it("escalates an unresponsive owned child and cancels escalation after exit", () => {
    vi.useFakeTimers();
    const manager = new ManagedProcesses(); managers.push(manager);
    const stuck = child(), exited = child();
    manager.add(stuck); manager.add(exited);
    manager.close();
    exited.emit("exit", 0, null);
    vi.advanceTimersByTime(2000);
    expect(stuck.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(exited.kill.mock.calls).toEqual([["SIGTERM"]]);
  });

  it("immediately terminates a child added after shutdown", () => {
    const manager = new ManagedProcesses(); managers.push(manager);
    manager.close();
    const late = child();
    manager.add(late);
    expect(late.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  });
});
