#!/usr/bin/env node
import http from "node:http";
import { mkdirSync, openSync, writeSync, chmodSync } from "node:fs";
import { WebSocketServer } from "ws";

const port = Number(process.env.NAB_PI_FIXTURE_PORT || 5499);
const logDir = `${process.env.HOME}/.local/state/native-agent-broker/probes/pi`;
mkdirSync(logDir, { recursive: true, mode: 0o700 });
chmodSync(logDir, 0o700);
const logPath = `${logDir}/fixture-${Date.now()}.jsonl`;
const fd = openSync(logPath, "a", 0o600);
const log = (event) => writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
let client;
let registration;

const server = http.createServer(async (req, res) => {
  if (req.url === "/native/agents" && req.method === "GET") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ agents: registration?.endpoints || [] }));
    return;
  }
  if (req.url === "/native/messages" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    log({ type: "native.send", binding: req.headers["x-nab-agent-id"], body });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ messageId: crypto.randomUUID(), conversationId: body.conversation_id || crypto.randomUUID(), status: "accepted" }));
    return;
  }
  if (req.url === "/inject" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!client || !registration) { res.statusCode = 409; res.end("not registered"); return; }
    const message = {
      messageId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
      fromAgentId: "nab:fixture:probe:sender", toAgentId: registration.endpoints[0].agentId,
      sourceInstanceId: "fixture", text: `Reply exactly PI_${body.mode}_OK_${body.nonce}`,
      createdAt: Date.now(), expiresAt: Date.now() + 600000, deliveryPolicy: body.mode === "busy" ? "steer" : "auto",
      expectsReply: true, schemaVersion: 1,
    };
    client.send(JSON.stringify({ type: "native.deliver", message }));
    log({ type: "native.inject", mode: body.mode, nonce: body.nonce, message });
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(message));
    return;
  }
  res.statusCode = 404; res.end("not found");
});
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  client = ws;
  ws.on("message", (raw) => {
    const value = JSON.parse(raw.toString());
    log({ type: "ws.receive", value });
    if (value.type === "native.register") {
      registration = value;
      ws.send(JSON.stringify({ type: "native.roster", agents: value.endpoints }));
    }
  });
  ws.on("close", () => { if (client === ws) client = undefined; });
});
server.listen(port, "127.0.0.1", () => {
  log({ type: "fixture.ready", port, logPath });
  process.stdout.write(`${JSON.stringify({ ready: true, port, logPath })}\n`);
});
