import type { ChildProcess } from "node:child_process";

/** Owns only child handles created by this launcher, never processes found by name. */
export class ManagedProcesses {
  private readonly children = new Set<ChildProcess>();
  private readonly signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  private stopped = false;
  private readonly interrupt = () => this.stopChildren();
  constructor() { for (const signal of this.signals) process.on(signal, this.interrupt); }
  add(child: ChildProcess) {
    this.children.add(child);
    child.once("exit", () => this.children.delete(child));
    child.once("error", () => this.children.delete(child));
    if (this.stopped) this.stopChild(child);
    return child;
  }
  private stopChild(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const deadline = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2000);
    deadline.unref();
    child.once("exit", () => clearTimeout(deadline));
  }
  private stopChildren() {
    if (this.stopped) return;
    this.stopped = true;
    for (const child of this.children) this.stopChild(child);
  }
  close() {
    this.stopChildren();
    for (const signal of this.signals) process.removeListener(signal, this.interrupt);
  }
}
