// Registry HTTP server — central discovery service on :4999
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  NativeClientFrameSchema, NativeError, NativeSendSchema, nativeAgentId,
  type NativeEndpoint, type NativeClientFrame, type NativeMessage, type NativeServerFrame,
} from "../native/contracts.js";
import { WebSocketServer, WebSocket } from "ws";
import { AgentStore } from "./store.js";
import { RegistryEventBus } from "./events.js";
import { ChannelStore } from "./channel-store.js";
import type { RegistryEvent } from "./events.js";
import type {
  AgentRegistration,
  AgentListFilter,
  AgentMessage,
  ChannelAck,
  ChannelMessage,
} from "../types/messages.js";

const REGISTRY_PORT = 4999;
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const ACK_SWEEP_INTERVAL_MS = 60_000;
const CONVERSATION_CLEANUP_INTERVAL_MS = 60 * 60_000; // hourly
const CONVERSATION_RETENTION_MS = 30 * 24 * 60 * 60_000; // 30 days
// Resolved (answered/failed) threads are pruned aggressively so a burst of
// handled traffic never buries or stalls fresh messages in any inbox.
const TERMINAL_SWEEP_INTERVAL_MS = 5 * 60_000; // every 5 min
const TERMINAL_RETENTION_MS = 60 * 60_000; // keep resolved threads 60 min

// Resolve the built dashboard. In a production/global install it ships next to
// the compiled server at dist/dashboard (`build:all` copies it there). In dev
// (tsx from src/) it lives at <repo>/dashboard/dist. Prefer the shipped copy and
// fall back to the dev path so both `node dist/...` and `pnpm dev` serve assets.
// fileURLToPath (not URL.pathname): pathname leaves spaces percent-encoded
// ("10.%20PERSONAL"), so existsSync fails on any repo path containing a space.
const dashboardDir =
  [
    new URL("../dashboard", import.meta.url), // dist/registry -> dist/dashboard (shipped)
    new URL("../../dashboard/dist", import.meta.url), // src/registry -> <repo>/dashboard/dist (dev)
  ]
    .map((u) => fileURLToPath(u))
    .find((p) => existsSync(p)) ?? fileURLToPath(new URL("../dashboard", import.meta.url));

export class RegistryServer {
  private eventBus = new RegistryEventBus();
  private store = new AgentStore(this.eventBus);
  private channelStore: ChannelStore;
  private wss?: WebSocketServer;
  private nativeTimer?: NodeJS.Timeout;
  private nativeHosts = new Map<string, { ws: WebSocket; instanceId: string; hostId: string; adapterId: string; lastSeen: number }>();
  private nativeBindings = new Map<WebSocket, string>();
  private app = express();
  private httpServer: ReturnType<typeof createServer> | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private ackSweepTimer: NodeJS.Timeout | null = null;
  private conversationCleanupTimer: NodeJS.Timeout | null = null;
  private terminalSweepTimer: NodeJS.Timeout | null = null;
  private wsClients = new Set<WebSocket>();
  private agentWsMap = new Map<string, WebSocket>();

  constructor(
    private readonly port = REGISTRY_PORT,
    private readonly options: { native?: boolean; dbPath?: string; host?: string } = {},
  ) {
    this.channelStore = new ChannelStore(options.dbPath);
    if (options.native) {
      this.channelStore.interruptNative();
      this.channelStore.saveNativeEndpoints(this.channelStore.nativeEndpoints().map((agent) => ({ ...agent, reachable: false })));
    }
    this.setupRoutes();
  }

  get address(): string {
    const address = this.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Registry is not listening");
    return `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
  }

  private nativeSend(ws: WebSocket, frame: NativeServerFrame): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  private nativeRoster(): void {
    const agents = this.channelStore.nativeEndpoints();
    for (const ws of this.wsClients) this.nativeSend(ws, { type: "native.roster", agents });
  }

  private disconnectNative(ws: WebSocket): void {
    const hostId = this.nativeBindings.get(ws);
    this.nativeBindings.delete(ws);
    if (!hostId || this.nativeHosts.get(hostId)?.ws !== ws) return;
    this.nativeHosts.delete(hostId);
    const endpoints = this.channelStore.nativeEndpoints().filter((agent) => this.channelStore.nativeAdapterKey(agent.agentId) === hostId);
    this.channelStore.interruptNative(endpoints.map((agent) => agent.agentId));
    this.channelStore.saveNativeEndpoints(endpoints.map((agent) => ({ ...agent, reachable: false })));
    this.nativeRoster();
  }

  private nativeFrame(ws: WebSocket, frame: NativeClientFrame): void {
    this.channelStore.assertHealthy();
    if (frame.type === "native.register") {
      const adapterId = frame.adapterId ?? frame.hostId;
      const adapterKey = JSON.stringify([frame.hostId, adapterId]);
      const bound = this.nativeBindings.get(ws);
      if (bound && bound !== adapterKey) throw new NativeError(409, "Connection is already bound to another host");
      const ids = new Set<string>();
      for (const agent of frame.endpoints) {
        if (agent.hostId !== frame.hostId || agent.instanceId !== frame.instanceId ||
          agent.agentId !== nativeAgentId(agent.hostId, agent.harness, agent.nativeSessionId) || ids.has(agent.agentId)) {
          throw new NativeError(400, "Invalid endpoint identity or duplicate endpoint");
        }
        const owner = this.channelStore.nativeAdapterKey(agent.agentId);
        if (owner && owner !== adapterKey) throw new NativeError(409, "Endpoint belongs to another adapter");
        ids.add(agent.agentId);
      }
      const previous = this.nativeHosts.get(adapterKey);
      const old = this.channelStore.nativeEndpoints().filter((agent) => this.channelStore.nativeAdapterKey(agent.agentId) === adapterKey);
      if (previous && (previous.ws !== ws || previous.instanceId !== frame.instanceId)) {
        this.channelStore.interruptNative(old.map((agent) => agent.agentId));
        if (previous.ws !== ws) {
          this.nativeBindings.delete(previous.ws);
          previous.ws.close(4001, "Superseded by snapshot reconnect");
        }
      }
      const removed = old.filter((agent) => !ids.has(agent.agentId));
      this.channelStore.interruptNative(removed.map((agent) => agent.agentId));
      this.channelStore.saveNativeEndpoints([
        ...removed.map((agent) => ({ ...agent, reachable: false })), ...frame.endpoints,
      ], adapterKey);
      this.nativeHosts.set(adapterKey, { ws, instanceId: frame.instanceId, hostId: frame.hostId, adapterId, lastSeen: Date.now() });
      this.nativeBindings.set(ws, adapterKey);
      this.nativeRoster();
      this.dispatchNative();
      return;
    }
    const hostId = this.nativeBindings.get(ws);
    const host = hostId ? this.nativeHosts.get(hostId) : undefined;
    if (!host || host.ws !== ws) throw new NativeError(409, "Register a host snapshot first");
    if (Date.now() - host.lastSeen >= 60_000) {
      this.nativeDisconnectSafely(ws);
      throw new NativeError(409, "Adapter lease expired; register a fresh connection");
    }
    if (frame.type === "native.heartbeat") {
      if (frame.hostId !== host.hostId || (frame.adapterId ?? frame.hostId) !== host.adapterId) throw new NativeError(409, "Heartbeat host does not match connection");
      this.nativeSend(ws, { type: "native.roster", agents: this.channelStore.nativeEndpoints() });
    } else {
      const message = this.channelStore.nativeMessage(frame.messageId);
      const recipient = this.channelStore.nativeEndpoints().find((agent) => agent.agentId === message?.toAgentId);
      if (!recipient || this.channelStore.nativeAdapterKey(recipient.agentId) !== hostId) throw new NativeError(409, "Receipt recipient is not on this host");
      this.channelStore.receiptNative(frame.messageId, host.instanceId, frame.state, frame.detail);
    }
    host.lastSeen = Date.now();
    this.dispatchNative();
  }

  private canDispatchNative(agent: NativeEndpoint, message: Pick<NativeMessage, "deliveryPolicy">): boolean {
    const host = this.nativeHosts.get(this.channelStore.nativeAdapterKey(agent.agentId) ?? "");
    if (!agent.reachable || !host || host.ws.readyState !== WebSocket.OPEN || Date.now() - host.lastSeen >= 60_000) return false;
    if (agent.state === "idle") return agent.capabilities.receiveIdle;
    return agent.state === "active" && message.deliveryPolicy !== "queue" && agent.capabilities.receiveBusy === "steer";
  }

  private dispatchNative(): void {
    // Every dispatch path (HTTP, WS and timer) expires leases before considering queued work.
    for (const host of this.nativeHosts.values()) {
      if (Date.now() - host.lastSeen >= 60_000) this.nativeDisconnectSafely(host.ws);
    }
    this.channelStore.maintainNative();
    const agents = new Map(this.channelStore.nativeEndpoints().map((agent) => [agent.agentId, agent]));
    const messages = this.channelStore.nativeMessages();
    const blocked = new Set(messages.filter((message) => message.state === "accepted" || message.state === "held").map((message) => message.toAgentId));
    for (const message of messages) {
      if (message.state !== "queued" || blocked.has(message.toAgentId)) continue;
      blocked.add(message.toAgentId); // FIFO head blocks later messages even if its policy cannot dispatch.
      const agent = agents.get(message.toAgentId);
      if (!agent || !this.canDispatchNative(agent, message)) continue;
      const host = this.nativeHosts.get(this.channelStore.nativeAdapterKey(agent.agentId) ?? "");
      if (!host) continue;
      const attempted = this.channelStore.attemptNative(message.messageId, host.instanceId);
      if (!attempted) continue;
      try {
        host.ws.send(JSON.stringify({ type: "native.deliver", message: attempted }), (error) => {
          if (error) this.nativeDisconnectSafely(host.ws);
        });
      } catch {
        this.disconnectNative(host.ws);
      }
    }
  }

  private nativeDisconnectSafely(ws: WebSocket): void {
    try { this.disconnectNative(ws); } catch { /* Storage failure stays visible via HTTP health; never resend. */ }
    ws.terminate();
  }

  private setupNativeRoutes(): void {
    this.app.get("/native/health", (_req, res) => {
      this.channelStore.assertHealthy();
      res.json({ status: "ok", profile: "native", hosts: this.nativeHosts.size });
    });
    this.app.get("/native/agents", (req, res) => {
      const query = typeof req.query.query === "string" ? req.query.query.toLowerCase() : "";
      const agents = this.channelStore.nativeEndpoints().filter((agent) =>
        (req.query.include_offline === "true" || agent.reachable) &&
        (!req.query.harness || req.query.harness === agent.harness) &&
        (!query || agent.displayName.toLowerCase().includes(query) || agent.agentId.toLowerCase().includes(query)));
      res.json({ agents });
    });
    this.app.get("/native/messages", (req, res) => {
      this.channelStore.maintainNative();
      res.json({ messages: this.channelStore.nativeMessages().filter((message) => !req.query.agent || message.fromAgentId === req.query.agent || message.toAgentId === req.query.agent).map((message) => {
        if (req.query.include_body === "true") return message;
        const { text: _text, ...metadata } = message;
        return metadata;
      }) });
    });
    this.app.post("/native/identity", (req, res) => {
      const endpoint = this.channelStore.nativeEndpoints().find((agent) => agent.agentId === req.get("x-nab-agent-id"));
      if (!endpoint || endpoint.harness !== "codex" || !endpoint.reachable || req.body?.name !== endpoint.displayName) throw new NativeError(409, "Identity must match a reachable registered Codex thread");
      const result = this.channelStore.claimNativeIdentity(endpoint, endpoint.displayName);
      this.dispatchNative();
      res.json({ revision: result.revision, changed: result.changed, messageId: result.message?.messageId });
    });
    this.app.post("/native/messages", (req, res) => {
      const parsed = NativeSendSchema.safeParse(req.body);
      if (!parsed.success) throw new NativeError(400, "Invalid native message payload");
      const endpoints = this.channelStore.nativeEndpoints();
      const sender = endpoints.find((agent) => agent.agentId === req.get("x-nab-agent-id"));
      if (!sender) throw new NativeError(400, "A registered sender binding is required");
      this.channelStore.maintainNative();
      const result = this.channelStore.acceptNative(sender, parsed.data, () => {
        const matches = endpoints.filter((agent) => agent.agentId === parsed.data.to);
        const candidates = matches.length ? matches : endpoints.filter((agent) => agent.displayName === parsed.data.to);
        const recipient = candidates[0];
        if (candidates.length !== 1 || !recipient) throw new NativeError(candidates.length ? 409 : 404, "Recipient is missing or ambiguous");
        const available = recipient.reachable && this.nativeHosts.get(this.channelStore.nativeAdapterKey(recipient.agentId) ?? "")?.ws.readyState === WebSocket.OPEN;
        if (!available && parsed.data.delivery !== "queue") throw new NativeError(409, "Recipient offline; use explicit queue policy");
        if (available && parsed.data.delivery === "steer" && !this.canDispatchNative(recipient, { deliveryPolicy: "steer" })) {
          throw new NativeError(409, "Recipient cannot accept steering in its current state");
        }
        if (available && parsed.data.delivery === "auto" && recipient.state === "active" && recipient.capabilities.receiveBusy === "unsupported") {
          throw new NativeError(409, "Recipient does not support busy delivery; use explicit queue policy");
        }
        return recipient;
      });
      this.dispatchNative();
      const message = this.channelStore.nativeMessage(result.message.messageId);
      if (!message) throw new Error("Accepted message disappeared from storage");
      const { text: _text, ...metadata } = message;
      res.status(result.created ? 201 : 200).json({ ...metadata, deduplicated: !result.created });
    });
    // No legacy mutation, history, event broadcast or relay in the native profile.
    this.app.use((_req, res) => { res.status(404).json({ error: "Route unavailable in native profile" }); });
    this.app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = error instanceof NativeError ? error.status :
        error instanceof SyntaxError ? 400 : 503;
      res.status(status).json({ error: error instanceof NativeError ? error.message : status === 400 ? "Invalid JSON" : "Storage unavailable" });
    });
  }

  private setupRoutes(): void {
    this.app.use(express.json({ limit: "512kb" }));
    if (this.options.native) {
      this.setupNativeRoutes();
      return;
    }

    // CORS headers for browser access
    this.app.use((_req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      next();
    });

    // Handle preflight (Express 5 requires named wildcard)
    this.app.options("/{*path}", (_req, res) => {
      res.sendStatus(204);
    });

    // Dashboard static files
    if (existsSync(dashboardDir)) {
      this.app.use("/dashboard", express.static(dashboardDir));
    } else {
      this.app.get("/dashboard", (_req, res) => {
        res.status(503).send(
          "Dashboard not built. Run: pnpm run build:dashboard"
        );
      });
    }

    // Register an agent
    this.app.post("/agents", (req, res) => {
      const registration = req.body as AgentRegistration;
      const entry = this.store.register(registration);
      res.status(201).json(entry);
    });

    // Deregister an agent
    this.app.delete("/agents/:id", (req, res) => {
      const removed = this.store.deregister(req.params.id);
      res.json({ removed });
    });

    // Heartbeat
    this.app.post("/agents/:id/heartbeat", (req, res) => {
      const updated = this.store.heartbeat(req.params.id);
      if (!updated) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      res.json({ ok: true, timestamp: Date.now() });
    });

    // List agents (with optional filters)
    this.app.get("/agents", (req, res) => {
      const filter: AgentListFilter = {
        skill: req.query.skill as string | undefined,
        project: req.query.project as string | undefined,
        healthy: req.query.healthy === "true" ? true : req.query.healthy === "false" ? false : undefined,
        entryType: req.query.entryType as "agent" | "client" | undefined,
      };
      res.json(this.store.list(filter));
    });

    // Get specific agent
    this.app.get("/agents/:id", (req, res) => {
      const entry = this.store.get(req.params.id);
      if (!entry) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      res.json(entry);
    });

    // Registry health
    this.app.get("/health", (_req, res) => {
      res.json({
        status: "ok",
        agents: this.store.count(),
        wsConnections: this.agentWsMap.size,
        wsDashboardClients: this.wsClients.size,
        timestamp: new Date().toISOString(),
      });
    });

    // AG-UI SSE proxy — forward streaming from dashboard → agent
    // Avoids cross-origin fetch issues; dashboard uses /agents/:id/ag-ui (same-origin via proxy)
    this.app.post("/agents/:id/ag-ui", async (req, res) => {
      const entry = this.store.get(req.params.id);
      if (!entry || !entry.url) {
        res.status(404).json({ error: "Agent not found or has no URL" });
        return;
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.flushHeaders();

      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      req.on("close", () => { reader?.cancel(); });

      try {
        const upstream = await fetch(`${entry.url}/ag-ui`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req.body),
        });

        if (!upstream.ok || !upstream.body) {
          res.write(`data: ${JSON.stringify({ type: "RUN_ERROR", message: `Agent HTTP ${upstream.status}` })}\n\n`);
          res.end();
          return;
        }

        reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done || !res.writable) break;
          res.write(value);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.write(`data: ${JSON.stringify({ type: "RUN_ERROR", message: msg })}\n\n`);
      }
      res.end();
    });

    // Task lifecycle events from agents
    this.app.post("/events", (req, res) => {
      const { agentId, agentName, taskId, state, skillId, timestamp, payload, clientId, clientName } = req.body as {
        agentId: string;
        agentName: string;
        taskId: string;
        state: string;
        skillId?: string;
        timestamp: string;
        payload?: unknown;
        clientId?: string;
        clientName?: string;
      };

      const event: RegistryEvent = {
        type: "task.update",
        timestamp: timestamp ?? new Date().toISOString(),
        data: { agentId, agentName, taskId, state, skillId, timestamp, payload, clientId, clientName },
      };

      this.eventBus.broadcast(event);
      res.json({ ok: true });
    });

    // Push a notification to the Claude terminal via claude/channel
    this.app.post("/notify-claude", (req, res) => {
      const { agentId, agentName, toAgentId, content, meta, conversationId, messageId, replyTo, taskId, requiresAck, expectsResponse, expiresAt } = req.body as {
        agentId?: string;
        agentName?: string;
        toAgentId?: string;
        content: string;
        meta?: Record<string, unknown>;
        conversationId?: string;
        messageId?: string;
        replyTo?: string;
        taskId?: string;
        requiresAck?: boolean;
        expectsResponse?: boolean;
        expiresAt?: number;
      };

      if (!content) {
        res.status(400).json({ error: "content is required" });
        return;
      }

      const { message, created } = this.channelStore.createMessage({
        conversationId,
        messageId,
        replyTo,
        fromAgentId: agentId ?? "unknown",
        fromAgentName: agentName,
        taskId,
        toAgentId: toAgentId ?? "claude",
        kind: "chat",
        content,
        meta,
        expiresAt,
        requiresAck,
        expectsResponse,
      });

      // Idempotency: if a duplicate `messageId` was posted (e.g. client retried due
      // to a transient network error), the store returns the original row and we
      // suppress the rebroadcast so receivers don't see it twice.
      if (created) {
        this.eventBus.broadcast({
          type: "channel.message",
          timestamp: new Date().toISOString(),
          data: message,
        });

        // Backward-compatible event for older listeners
        this.eventBus.broadcast({
          type: "claude.notify",
          timestamp: new Date().toISOString(),
          data: { agentId, agentName, content, meta, conversationId: message.conversationId, messageId: message.messageId },
        });

        // Targeted delivery: if message has a specific recipient, send directly to their WS.
        // sendToAgent evicts the agentWsMap entry if the socket has died since the
        // last keepalive cycle.
        if (message.toAgentId) {
          this.sendToAgent(message.toAgentId, {
            type: "channel.message",
            timestamp: new Date().toISOString(),
            data: message,
          });
        }
      }

      res.json({ ok: true, conversationId: message.conversationId, messageId: message.messageId, deduplicated: !created });
    });

    this.app.post("/channel/messages", (req, res) => {
      const body = req.body as Partial<ChannelMessage>;

      if (!body.content || !body.fromAgentId || !body.kind) {
        res.status(400).json({ error: "fromAgentId, kind and content are required" });
        return;
      }

      const revived = body.conversationId
        ? this.channelStore.reviveConversation(body.conversationId)
        : false;
      const { message, created } = this.channelStore.createMessage({
        conversationId: body.conversationId,
        messageId: body.messageId,
        replyTo: body.replyTo,
        fromAgentId: body.fromAgentId,
        fromAgentName: body.fromAgentName,
        toAgentId: body.toAgentId,
        taskId: body.taskId,
        kind: body.kind,
        content: body.content,
        meta: body.meta,
        createdAt: body.createdAt,
        expiresAt: body.expiresAt,
        attemptCount: body.attemptCount,
        requiresAck: body.requiresAck,
        expectsResponse: body.expectsResponse,
        identity: body.identity,
      });

      // Idempotency: if a duplicate `messageId` was posted, suppress all broadcasts.
      // The 200 response below still echoes the canonical persisted message so the
      // caller can treat the retry as success.
      if (created) {
        // Send revive BEFORE the message so receiving clients clear deletedConversationIds
        // before trackMessage() runs — otherwise the message would be silently dropped.
        if (revived) {
          this.eventBus.broadcast({
            type: "channel.conversation.revived",
            timestamp: new Date().toISOString(),
            data: { conversationId: message.conversationId },
          });
        }

        this.eventBus.broadcast({
          type: "channel.message",
          timestamp: new Date().toISOString(),
          data: message,
        });

        // Targeted delivery via sendToAgent (auto-evicts dead WS).
        if (message.toAgentId) {
          this.sendToAgent(message.toAgentId, {
            type: "channel.message",
            timestamp: new Date().toISOString(),
            data: message,
          });
        }
      }

      res.status(created ? 201 : 200).json({ ...message, deduplicated: !created });
    });

    this.app.post("/channel/acks", (req, res) => {
      const body = req.body as ChannelAck;
      if (!body.conversationId || !body.messageId || !body.state || !body.actorId || !body.actorType) {
        res.status(400).json({ error: "conversationId, messageId, state, actorId and actorType are required" });
        return;
      }

      const ack = this.channelStore.addAck({
        ...body,
        timestamp: body.timestamp ?? Date.now(),
      });

      this.eventBus.broadcast({
        type: "channel.ack",
        timestamp: new Date().toISOString(),
        data: ack,
      });

      res.status(201).json(ack);
    });

    this.app.get("/channel/conversations/:id", (req, res) => {
      const snapshot = this.channelStore.getConversation(req.params.id);
      if (!snapshot) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      res.json(snapshot);
    });

    this.app.get("/channel/conversations", (req, res) => {
      const pendingOnly = req.query.pending === "true";
      res.json(this.channelStore.listConversations({ pendingOnly }));
    });

    this.app.post("/channel/conversations/:id/suppress", (req, res) => {
      const suppressed = this.channelStore.suppressConversation(req.params.id);
      if (!suppressed) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }

      this.eventBus.broadcast({
        type: "channel.conversation.suppressed",
        timestamp: new Date().toISOString(),
        data: { conversationId: req.params.id },
      });

      res.json({ suppressed: true });
    });

    this.app.delete("/channel/conversations/:id/suppress", (req, res) => {
      const revived = this.channelStore.reviveConversation(req.params.id);
      this.eventBus.broadcast({
        type: "channel.conversation.revived",
        timestamp: new Date().toISOString(),
        data: { conversationId: req.params.id },
      });
      res.json({ revived });
    });

    this.app.post("/channel/messages/:conversationId/:messageId/retry", (req, res) => {
      const retried = this.channelStore.retryMessage(req.params.conversationId, req.params.messageId);
      if (!retried) {
        res.status(404).json({ error: "Message not found" });
        return;
      }

      this.eventBus.broadcast({
        type: "channel.message",
        timestamp: new Date().toISOString(),
        data: retried,
      });

      this.eventBus.broadcast({
        type: "channel.ack",
        timestamp: new Date().toISOString(),
        data: this.channelStore.addAck({
          conversationId: retried.conversationId,
          messageId: retried.messageId,
          state: "queued",
          actorId: "registry",
          actorType: "registry",
          timestamp: Date.now(),
          detail: `Retry attempt ${retried.attemptCount ?? 1}`,
        }),
      });

      // Targeted delivery: if message has a specific recipient, send directly to their WS
      if (retried.toAgentId) {
        this.sendToAgent(retried.toAgentId, {
          type: "channel.message",
          timestamp: new Date().toISOString(),
          data: retried,
        });
      }

      res.json(retried);
    });

    // Send message to a specific agent via registry relay
    this.app.post("/agents/:id/message", (req, res) => {
      const targetId = req.params.id;
      const message = req.body as AgentMessage;

      // Try to find agent by ID or name
      const entry = this.store.get(targetId) ??
        this.store.list().find((a) => a.name.toLowerCase() === targetId.toLowerCase());

      if (!entry) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const resolvedId = entry.agentId;
      const sent = this.sendToAgent(resolvedId, {
        type: "agent.message",
        timestamp: new Date().toISOString(),
        data: message,
      });

      if (sent) {
        // Broadcast to dashboard subscribers too
        this.eventBus.broadcast({
          type: "agent.message",
          timestamp: new Date().toISOString(),
          data: message,
        });
        res.json({ ok: true, delivered: true, via: "websocket" });
      } else {
        // No WS — broadcast event, caller should fallback to HTTP direct
        this.eventBus.broadcast({
          type: "agent.message",
          timestamp: new Date().toISOString(),
          data: message,
        });
        res.json({ ok: true, delivered: false, via: "event-only" });
      }
    });
  }

  async start(): Promise<void> {
    this.httpServer = createServer(this.app);

    // WebSocket server on /ws path
    const wss = new WebSocketServer({ server: this.httpServer, path: "/ws", maxPayload: 1024 * 1024 });
    this.wss = wss;

    // WebSocket keepalive: ping every 15s, terminate if no pong within 15s.
    // Worst-case zombie window is ~30s (one missed cycle + the next), versus
    // ~50s with the previous 25s interval.
    //
    // When we terminate a zombie, we also evict its entry from agentWsMap so
    // targeted delivery doesn't silently write into a dead socket while waiting
    // for the natural `close` event to fire. Without this, every agentWsMap
    // lookup between terminate() and the close handler would race with a
    // half-open socket whose readyState may still report OPEN.
    const wsPingInterval = setInterval(() => {
      for (const client of wss.clients) {
        if ((client as any)._isAlive === false) {
          const agentId = (client as any)._identifiedAgentId as string | undefined;
          if (agentId && this.agentWsMap.get(agentId) === client) {
            this.agentWsMap.delete(agentId);
            console.error(`[Registry] WS keepalive: evicted ${agentId} from routing map (no pong)`);
          }
          client.terminate();
          continue;
        }
        (client as any)._isAlive = false;
        client.ping();
      }
    }, 15_000);

    wss.on("close", () => clearInterval(wsPingInterval));

    wss.on("connection", (ws) => {
      (ws as any)._isAlive = true;
      ws.on("pong", () => { (ws as any)._isAlive = true; });
      this.wsClients.add(ws);
      if (this.options.native) {
        try { this.nativeSend(ws, { type: "native.roster", agents: this.channelStore.nativeEndpoints() }); }
        catch { this.nativeSend(ws, { type: "native.error", error: "Storage unavailable" }); }
        ws.on("message", (raw) => {
          try {
            const parsed = NativeClientFrameSchema.safeParse(JSON.parse(raw.toString()));
            if (!parsed.success) throw new NativeError(400, "Invalid native frame");
            this.nativeFrame(ws, parsed.data);
          } catch (error) {
            this.nativeSend(ws, { type: "native.error", error: error instanceof NativeError ? error.message : "Native request failed" });
          }
        });
        ws.on("close", () => {
          this.wsClients.delete(ws);
          this.nativeDisconnectSafely(ws);
        });
        ws.on("error", () => this.nativeDisconnectSafely(ws));
        return;
      }
      let identifiedAgentId: string | null = null;

      // Send snapshot of current agents
      ws.send(
        JSON.stringify({ type: "snapshot", agents: this.store.list() })
      );

      // Subscribe to EventBus and forward events
      const onEvent = (event: RegistryEvent) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(event));
        }
      };
      this.eventBus.on("event", onEvent);

      // Handle incoming messages from agents
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          // Agent identification — agent sends { type: "identify", agentId: "..." }
          if (msg.type === "identify" && msg.agentId) {
            // Same agent re-identifying on the same socket — just ack, no re-mapping
            if (identifiedAgentId === msg.agentId && this.agentWsMap.get(msg.agentId) === ws) {
              ws.send(JSON.stringify({ type: "identified", agentId: msg.agentId }));
              return;
            }

            if (identifiedAgentId && identifiedAgentId !== msg.agentId) {
              const previousWs = this.agentWsMap.get(identifiedAgentId);
              if (previousWs === ws) {
                this.agentWsMap.delete(identifiedAgentId);
              }
            }

            const existingWs = this.agentWsMap.get(msg.agentId);
            if (existingWs && existingWs !== ws) {
              this.agentWsMap.delete(msg.agentId);
              try {
                existingWs.close(4001, "Superseded by a newer registry connection");
              } catch {
                existingWs.terminate();
              }
            }

            identifiedAgentId = msg.agentId;
            // Stamp the agentId on the WS itself so the keepalive interval
            // (which iterates wss.clients, not agentWsMap) can evict the
            // routing entry in O(1) when a zombie is terminated.
            (ws as any)._identifiedAgentId = msg.agentId;
            this.agentWsMap.set(msg.agentId, ws);
            console.error(`[Registry WS] Agent identified: ${msg.agentId}`);

            // Clean up stale store entries for the same logical client (same projectPath + clientName)
            const identifiedEntry = this.store.get(msg.agentId);
            if (identifiedEntry?.entryType === "client" && identifiedEntry.clientInfo?.clientName) {
              for (const other of this.store.list()) {
                if (
                  other.agentId !== msg.agentId &&
                  other.entryType === "client" &&
                  other.clientInfo?.clientName === identifiedEntry.clientInfo.clientName &&
                  other.projectPath === identifiedEntry.projectPath
                ) {
                  this.store.deregister(other.agentId);
                  const otherWs = this.agentWsMap.get(other.agentId);
                  if (otherWs) {
                    this.agentWsMap.delete(other.agentId);
                    try { otherWs.close(4001, "Superseded"); } catch { otherWs.terminate(); }
                  }
                }
              }
            }

            ws.send(JSON.stringify({ type: "identified", agentId: msg.agentId }));
            return;
          }

          // Agent-to-agent message relay
          if (msg.type === "agent.message" && msg.data?.toAgentId) {
            this.sendToAgent(msg.data.toAgentId, msg);
            // Broadcast to dashboard too
            this.eventBus.broadcast({
              type: "agent.message",
              timestamp: new Date().toISOString(),
              data: msg.data,
            });
          }
        } catch {
          // Ignore parse errors from non-JSON messages
        }
      });

      ws.on("close", () => {
        this.wsClients.delete(ws);
        this.eventBus.off("event", onEvent);
        if (identifiedAgentId) {
          const mappedWs = this.agentWsMap.get(identifiedAgentId);
          if (mappedWs === ws) {
            this.agentWsMap.delete(identifiedAgentId);
            const entry = this.store.get(identifiedAgentId);
            if (entry?.entryType === "client") {
              // Client sessions are bound to their CLI process. Remove immediately on WS drop
              // so the dashboard and list_agents never show a zombie entry when the CLI dies.
              this.store.deregister(identifiedAgentId);
            } else {
              // Agents may still serve HTTP after losing their WS — just mark unhealthy so the
              // dashboard reflects the disconnect without waiting 2 minutes for the health check.
              this.store.markUnhealthy(identifiedAgentId);
            }
            console.error(`[Registry WS] Disconnected: ${identifiedAgentId}`);
          }
        }
      });

      ws.on("error", (err) => {
        console.error(`[Registry WS] Error: ${err.message}`);
        this.wsClients.delete(ws);
        this.eventBus.off("event", onEvent);
        if (identifiedAgentId) {
          const mappedWs = this.agentWsMap.get(identifiedAgentId);
          if (mappedWs === ws) {
            this.agentWsMap.delete(identifiedAgentId);
            const entry = this.store.get(identifiedAgentId);
            if (entry?.entryType === "client") {
              this.store.deregister(identifiedAgentId);
            } else {
              this.store.markUnhealthy(identifiedAgentId);
            }
          }
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`Port ${this.port} is already in use — another registry (or process) is bound to it. Stop it, or start on a different port with --port.`));
        } else {
          reject(err);
        }
      };
      this.httpServer!.once("error", onError);
      this.httpServer!.listen(this.port, this.options.host ?? "127.0.0.1", () => {
        this.httpServer!.removeListener("error", onError);
        resolve();
      });
    });

    if (this.options.native) {
      this.nativeTimer = setInterval(() => {
        try {
          this.dispatchNative();
        } catch { /* HTTP returns an explicit storage error; do not recreate storage. */ }
      }, 1000);
      return;
    }

    this.healthCheckTimer = setInterval(() => {
      this.store.healthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);

    // Ack sweeper: every minute, mark as `failed` any message that requested a
    // response, has passed its expiresAt deadline, and never reached a terminal
    // ack. This unblocks senders waiting on the conversation state machine and
    // gives the dashboard a definitive end-state instead of a "pending forever".
    this.ackSweepTimer = setInterval(() => this.sweepExpiredAcks(), ACK_SWEEP_INTERVAL_MS);

    // Conversation cleanup: hourly, delete conversations whose last activity is
    // older than the retention window. Bounds SQLite growth on long-running
    // registries without affecting any active conversation.
    this.conversationCleanupTimer = setInterval(
      () => this.sweepStaleConversations(),
      CONVERSATION_CLEANUP_INTERVAL_MS,
    );

    // Terminal sweep: every few minutes, delete answered/failed threads older
    // than the short terminal-retention window so resolved traffic can't
    // saturate inboxes or slow the per-call conversation scan.
    this.terminalSweepTimer = setInterval(
      () => this.sweepTerminalConversations(),
      TERMINAL_SWEEP_INTERVAL_MS,
    );

    console.error(`[Registry] Listening on http://localhost:${this.port}`);
    console.error(`[Registry] Dashboard: http://localhost:${this.port}/dashboard`);
  }

  /** Send a payload directly to the WS mapped for `agentId`. Returns false and
   *  evicts the entry from `agentWsMap` if the socket is missing, not OPEN, or
   *  the synchronous send throws. The keepalive interval still catches zombies
   *  whose readyState wrongly reports OPEN within ~30 s, but this helper covers
   *  the cases visible at send time without waiting for the next ping cycle. */
  private sendToAgent(agentId: string, payload: unknown): boolean {
    const ws = this.agentWsMap.get(agentId);
    if (!ws) return false;
    if (ws.readyState !== WebSocket.OPEN) {
      this.agentWsMap.delete(agentId);
      return false;
    }
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      this.agentWsMap.delete(agentId);
      console.error(`[Registry] sendToAgent(${agentId}) failed, evicted: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  private sweepStaleConversations(): void {
    try {
      const cutoff = Date.now() - CONVERSATION_RETENTION_MS;
      const removed = this.channelStore.deleteConversationsOlderThan(cutoff);
      if (removed > 0) {
        console.error(`[Registry] Cleanup removed ${removed} stale conversation(s) older than ${CONVERSATION_RETENTION_MS / (24 * 60 * 60_000)} day(s)`);
      }
    } catch (err: unknown) {
      console.error("[Registry] Conversation cleanup failed:", err instanceof Error ? err.message : err);
    }
  }

  private sweepTerminalConversations(): void {
    try {
      const cutoff = Date.now() - TERMINAL_RETENTION_MS;
      const removed = this.channelStore.deleteTerminalConversationsOlderThan(cutoff);
      if (removed > 0) {
        console.error(`[Registry] Terminal sweep removed ${removed} resolved conversation(s) older than ${TERMINAL_RETENTION_MS / 60_000} min`);
      }
    } catch (err: unknown) {
      console.error("[Registry] Terminal sweep failed:", err instanceof Error ? err.message : err);
    }
  }

  private sweepExpiredAcks(): void {
    try {
      const expired = this.channelStore.findExpiredAwaitingReply(Date.now());
      if (expired.length === 0) return;
      for (const message of expired) {
        const ack = this.channelStore.addAck({
          conversationId: message.conversationId,
          messageId: message.messageId,
          state: "failed",
          actorId: "registry",
          actorType: "registry",
          timestamp: Date.now(),
          detail: "Expired without reply (registry sweeper)",
        });
        this.eventBus.broadcast({
          type: "channel.ack",
          timestamp: new Date().toISOString(),
          data: ack,
        });
      }
      console.error(`[Registry] Ack sweeper marked ${expired.length} expired message(s) as failed`);
    } catch (err: unknown) {
      console.error("[Registry] Ack sweeper failed:", err instanceof Error ? err.message : err);
    }
  }

  async stop(): Promise<void> {
    if (this.nativeTimer) clearInterval(this.nativeTimer);
    if (this.options.native) {
      try {
        this.channelStore.interruptNative();
        this.channelStore.saveNativeEndpoints(this.channelStore.nativeEndpoints().map((agent) => ({ ...agent, reachable: false })));
      } catch { /* Preserve storage failure; stop must still close resources. */ }
      this.nativeHosts.clear();
      this.nativeBindings.clear();
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
    if (this.ackSweepTimer) {
      clearInterval(this.ackSweepTimer);
    }
    if (this.conversationCleanupTimer) {
      clearInterval(this.conversationCleanupTimer);
    }
    if (this.terminalSweepTimer) {
      clearInterval(this.terminalSweepTimer);
    }

    // Close all WS clients
    for (const ws of this.wsClients) {
      ws.terminate();
    }
    this.wsClients.clear();

    this.wss?.close();
    if (this.httpServer?.listening) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    this.channelStore.close();
  }
}
