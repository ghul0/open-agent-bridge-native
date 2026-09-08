#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import process from "node:process";
import { WebSocket } from "ws";

const [url, tracePath, command, ...args] = process.argv.slice(2);
if (!url || !tracePath || !command) {
  console.error("usage: codex-ws-rpc.mjs URL TRACE (list|start|steer|probe) [args...]");
  process.exit(2);
}

const ws = new WebSocket(url);
let nextId = 1;
const pending = new Map();
const notifications = [];
const trace = (direction, message) => {
  appendFileSync(tracePath, `${JSON.stringify({ at: new Date().toISOString(), direction, message })}\n`, { mode: 0o600 });
};
const send = (message) => {
  trace("out", message);
  ws.send(JSON.stringify(message));
};
const request = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});
const waitForIdle = async (threadId, timeoutMs = 120000) => {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const result = await request("thread/read", { threadId, includeTurns: true });
    if (result.thread?.status?.type === "idle") return result.thread;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("thread idle timeout");
};

ws.on("message", (data) => {
  const message = JSON.parse(String(data));
  trace("in", message);
  if (message.id !== undefined && message.method) {
    send({ id: message.id, error: { code: -32601, message: `Unsupported client request: ${message.method}` } });
  } else if (message.id !== undefined) {
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    }
  } else if (message.method) {
    notifications.push(message);
  }
});

ws.on("open", async () => {
  try {
    await request("initialize", {
      clientInfo: { name: "nab-codex-probe", version: "0.1.0" },
      capabilities: { experimentalApi: true },
      protocolVersion: "0.1.0",
    });
    send({ method: "initialized" });

    if (command === "list") {
      console.log(JSON.stringify(await request("thread/list", { limit: 20 }), null, 2));
    } else if (command === "start") {
      const [threadId, text] = args;
      console.log(JSON.stringify(await request("turn/start", { threadId, input: [{ type: "text", text }] }), null, 2));
    } else if (command === "steer") {
      const [threadId, expectedTurnId, text] = args;
      console.log(JSON.stringify(await request("turn/steer", { threadId, expectedTurnId, input: [{ type: "text", text }] }), null, 2));
    } else if (command === "probe") {
      const [threadId, idleText, busyText, steerText] = args;
      const idle = await request("turn/start", { threadId, input: [{ type: "text", text: idleText }] });
      const idleTurnId = idle.turn?.id ?? idle.turnId;
      await waitForIdle(threadId);
      const busy = await request("turn/start", { threadId, input: [{ type: "text", text: busyText }] });
      const expectedTurnId = busy.turn?.id ?? busy.turnId;
      const steered = await request("turn/steer", {
        threadId,
        expectedTurnId,
        input: [{ type: "text", text: steerText }],
      });
      await waitForIdle(threadId);
      console.log(JSON.stringify({ threadId, idleTurnId, expectedTurnId, steered }, null, 2));
    }
    ws.close();
  } catch (error) {
    console.error(error.stack ?? String(error));
    ws.close();
    process.exitCode = 1;
  }
});
ws.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
