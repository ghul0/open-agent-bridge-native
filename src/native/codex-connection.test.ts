import { createServer, type Server } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { CodexConnection, RpcError } from "./codex-connection.js";

type Message = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

type FakeServer = {
  path: string;
  http: Server;
  wss: WebSocketServer;
  socket: () => WebSocket;
  messages: Message[];
};

const servers: FakeServer[] = [];
const clients: CodexConnection[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(
    servers.splice(0).map(
      ({ path, http, wss }) =>
        new Promise<void>((resolve) => {
          wss.close();
          http.close(() => void rm(path, { force: true }).finally(resolve));
        }),
    ),
  );
});

async function fakeServer(
  onMessage?: (message: Message, socket: WebSocket) => void,
): Promise<FakeServer> {
  const path = join(tmpdir(), `nab-codex-${randomUUID()}.sock`);
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  http.on("upgrade", (request, socket, head) => {
    if (request.headers.host !== "localhost") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit("connection", webSocket, request);
    });
  });
  const sockets: WebSocket[] = [];
  const messages: Message[] = [];
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Message;
      messages.push(message);
      if (message.method === "initialize" && message.id !== undefined) {
        socket.send(JSON.stringify({ id: message.id, result: { userAgent: "fake" } }));
      } else {
        onMessage?.(message, socket);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(path, resolve);
  });
  const server = { path, http, wss, socket: () => sockets[0], messages };
  servers.push(server);
  return server;
}

async function connect(server: FakeServer, options: { requestTimeoutMs?: number } = {}) {
  const client = new CodexConnection({ url: `unix://${server.path}`, ...options });
  clients.push(client);
  await client.connect();
  return client;
}

function waitForDisconnect(client: CodexConnection): Promise<void> {
  return new Promise((resolve) => client.once("disconnected", resolve));
}

describe("CodexConnection", () => {
  it("exports the reusable connection API and initializes experimental API", async () => {
    const server = await fakeServer();
    const client = await connect(server);

    expect(client.connected).toBe(true);
    expect(server.messages[0]).toMatchObject({
      method: "initialize",
      params: { capabilities: { experimentalApi: true } },
    });
    await vi.waitFor(() => expect(server.messages[1]).toEqual({ method: "initialized" }));
  });

  it("correlates concurrent thread requests and emits fragmented notifications", async () => {
    const pending = new Map<string, number | string>();
    const server = await fakeServer((message, socket) => {
      if (message.method !== "thread/read" || message.id === undefined) return;
      const threadId = String(message.params?.threadId);
      pending.set(threadId, message.id);
      if (pending.size !== 2) return;
      socket.send(JSON.stringify({ id: pending.get("thread-b"), result: { thread: { id: "thread-b" } } }));
      socket.send('{"method":"turn/started",', { fin: false });
      socket.send('"params":{"threadId":"thread-a"}}', { fin: true });
      socket.send(JSON.stringify({ id: pending.get("thread-a"), result: { thread: { id: "thread-a" } } }));
    });
    const client = await connect(server);
    const notifications: unknown[][] = [];
    client.on("notification", (...args) => notifications.push(args));

    const [a, b] = await Promise.all([
      client.request<{ thread: { id: string } }>("thread/read", { threadId: "thread-a" }),
      client.request<{ thread: { id: string } }>("thread/read", { threadId: "thread-b" }),
    ]);

    expect(a.thread.id).toBe("thread-a");
    expect(b.thread.id).toBe("thread-b");
    expect(notifications).toEqual([["turn/started", { threadId: "thread-a" }]]);
  });

  it("exposes server requests without automatically approving or rejecting them", async () => {
    const callback = vi.fn();
    const server = await fakeServer();
    const client = new CodexConnection({
      url: `unix://${server.path}`,
      onServerRequest: callback,
    });
    clients.push(client);
    const event = vi.fn();
    client.on("serverRequest", event);
    await client.connect();

    server.socket().send(
      JSON.stringify({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-a" },
      }),
    );
    await vi.waitFor(() => expect(event).toHaveBeenCalledOnce());
    expect(callback).toHaveBeenCalledWith(
      "approval-1",
      "item/commandExecution/requestApproval",
      { threadId: "thread-a" },
    );
    expect(server.messages).toHaveLength(2);

    client.respond("approval-1", { result: { decision: "decline" } });
    await vi.waitFor(() => expect(server.messages).toHaveLength(3));
    expect(server.messages[2]).toEqual({ id: "approval-1", result: { decision: "decline" } });
  });

  it("closes on invalid JSON without leaking sensitive frame contents", async () => {
    const server = await fakeServer();
    const client = await connect(server);
    const disconnected = waitForDisconnect(client);

    server.socket().send('{"secret":"do-not-log"');
    await disconnected;

    expect(client.connected).toBe(false);
  });

  it("times out requests and marks only ambiguous turn sends uncertain", async () => {
    const server = await fakeServer();
    const client = await connect(server, { requestTimeoutMs: 20 });

    await expect(client.request("thread/read", { threadId: "thread-a" })).rejects.toMatchObject({
      name: "RpcError",
      method: "thread/read",
      uncertain: false,
    });
    await expect(client.request("turn/start", { threadId: "thread-a" })).rejects.toMatchObject({
      name: "RpcError",
      method: "turn/start",
      uncertain: true,
    });
  });

  it("rejects pending work and disconnects cleanly on peer close", async () => {
    const server = await fakeServer();
    const client = await connect(server);
    const disconnected = waitForDisconnect(client);
    const request = client.request("turn/steer", {
      threadId: "thread-a",
      expectedTurnId: "turn-a",
    });

    server.socket().close(1000, "done");

    await expect(request).rejects.toBeInstanceOf(RpcError);
    await expect(request).rejects.toMatchObject({ method: "turn/steer", uncertain: true });
    await disconnected;
    expect(client.connected).toBe(false);
  });
});
