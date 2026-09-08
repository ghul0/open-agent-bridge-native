import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { CodexRuntime } from "../native/codex-runtime.js";

const servers: WebSocketServer[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

async function harness(status: "idle" | "active", turnId = "turn-1") {
  const requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (ws) => ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (!message.method || message.id === undefined) return;
    requests.push(message);
    if (message.method === "initialize") ws.send(JSON.stringify({ id: message.id, result: {} }));
    else if (message.method === "thread/read") ws.send(JSON.stringify({ id: message.id, result: { thread: { id: "bound", status: { type: status }, turns: status === "active" ? [{ id: turnId, status: "inProgress" }] : [] } } }));
    else if (message.method === "turn/start") ws.send(JSON.stringify({ id: message.id, result: { turn: { id: "started" } } }));
    else if (message.method === "turn/steer") ws.send(JSON.stringify({ id: message.id, result: { turnId } }));
  }));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
  const runtime = new CodexRuntime({ appServerUrl: `ws://127.0.0.1:${address.port}`, threadId: "bound" }); await runtime.connect();
  return { runtime, requests, server };
}

describe("CodexRuntime delivery", () => {
  it("starts an idle thread even for queue policy", async () => {
    const { runtime, requests } = await harness("idle");
    expect(await runtime.deliver("hello", { policy: "queue" })).toMatchObject({ state: "runtime_accepted", method: "turn/start", turnId: "started" });
    expect(requests.find((r) => r.method === "turn/start")?.params).toMatchObject({ threadId: "bound" });
    runtime.disconnect();
  });

  it("auto steers a busy bound thread with expectedTurnId", async () => {
    const { runtime, requests } = await harness("active", "expected");
    expect(await runtime.deliver("hello", { policy: "auto" })).toMatchObject({ state: "runtime_accepted", method: "turn/steer", turnId: "expected", expectedTurnId: "expected" });
    expect(requests.find((r) => r.method === "turn/steer")?.params).toMatchObject({ threadId: "bound", expectedTurnId: "expected" });
    runtime.disconnect();
  });

  it("rejects server requests and filters foreign thread events", async () => {
    const { runtime, server } = await harness("idle");
    const socket = [...server.clients][0];
    const reply = new Promise<Record<string, unknown>>((resolve) => socket.once("message", (raw) => { const value = JSON.parse(String(raw)); if (value.id === 99) resolve(value); }));
    socket.send(JSON.stringify({ id: 99, method: "execCommandApproval", params: {} }));
    expect(await reply).toMatchObject({ id: 99, error: { code: -32601 } });
    socket.send(JSON.stringify({ method: "turn/started", params: { threadId: "foreign", turn: { id: "wrong" } } }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runtime.health()).toMatchObject({ threadId: "bound", state: "idle", activeTurnId: null });
    runtime.disconnect();
  });
});
