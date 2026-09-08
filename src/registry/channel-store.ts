import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import {
  NativeEndpointSchema,
  NativeError,
  type NativeEndpoint,
  type NativeMessage,
  type NativeMessageState,
  type NativeSend,
} from "../native/contracts.js";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  ChannelAck,
  ChannelConversationListEntry,
  ChannelConversationSnapshot,
  ChannelMessage,
} from "../types/messages.js";

export interface NativeAdapterOwnershipMapping {
  agentId: string;
  beforeAdapterId: string;
  afterAdapterId: string;
}

export interface NativeIdentityClaim {
  revision: number;
  changed: boolean;
  message?: NativeMessage;
}

function defaultDbPath(): string {
  // Per-user, NOT process.cwd(): the registry is one shared daemon, and a
  // cwd-relative DB lands inside whatever project it happened to start from —
  // which then gets deleted under it (SQLITE_READONLY_DBMOVED, sends 500).
  return resolve(homedir(), ".open-agent-bridge", "registry.sqlite");
}

export class ChannelStore {
  private db: DatabaseSync;
  private readonly dbPath: string;
  private identity?: { dev: number; ino: number };
  private storageLost = false;

  constructor(dbPath = defaultDbPath()) {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:" && existsSync(`${dbPath}.initialized`) && !existsSync(dbPath)) {
      throw new Error("Storage lost; restore history before restarting");
    }
    this.db = this.open();
    if (dbPath !== ":memory:") {
      this.identity = statSync(dbPath);
      // A durable sentinel prevents restart from treating a deleted ledger as first boot.
      if (!existsSync(`${dbPath}.initialized`)) writeFileSync(`${dbPath}.initialized`, "ChannelStore initialized\n", { flag: "wx", mode: 0o600 });
    }
  }

  assertHealthy(): void {
    if (this.identity) {
      try {
        const current = statSync(this.dbPath);
        if (current.dev !== this.identity.dev || current.ino !== this.identity.ino) this.storageLost = true;
      } catch {
        this.storageLost = true;
      }
    }
    if (this.storageLost) throw new Error("Storage lost or replaced; restore history before restarting");
    this.db.prepare("SELECT 1").get();
  }

  close(): void {
    this.db.close();
  }

  /** Consistent SQLite snapshot, including committed WAL data. Never overwrite a backup. */
  backup(destination: string): { dbPath: string; markerPath: string } {
    this.assertHealthy();
    const dbPath = resolve(destination), markerPath = `${dbPath}.initialized`;
    if ([dbPath, markerPath, `${dbPath}-wal`, `${dbPath}-shm`].some(existsSync)) {
      throw new Error("Backup destination already exists");
    }
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    // Reserve a private empty file; VACUUM INTO accepts an empty destination.
    writeFileSync(dbPath, "", { flag: "wx", mode: 0o600 });
    try {
      this.db.prepare("VACUUM INTO ?").run(dbPath);
      this.assertHealthy();
      writeFileSync(markerPath, "ChannelStore initialized\n", { flag: "wx", mode: 0o600 });
    } catch (error) {
      unlinkSync(dbPath);
      throw error;
    }
    return { dbPath, markerPath };
  }

  private open(): DatabaseSync {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const db = new DatabaseSync(this.dbPath);
    // The homedir DB is shared by every registry daemon a user starts: WAL lets
    // one read while another writes, busy_timeout waits out cross-process locks
    // instead of throwing SQLITE_BUSY straight into a 500.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_messages (
        message_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_channel_messages_conversation
        ON channel_messages (conversation_id, created_at);

      CREATE TABLE IF NOT EXISTS channel_acks (
        ack_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_channel_acks_conversation
        ON channel_acks (conversation_id, timestamp);

      CREATE TABLE IF NOT EXISTS channel_suppressed_conversations (
        conversation_id TEXT PRIMARY KEY,
        suppressed_at INTEGER NOT NULL
      );
    `);
    // Add native metadata to the existing ledger, not a parallel message store.
    const columns = db.prepare("PRAGMA table_info(channel_messages)").all() as Array<{ name: string }>;
    for (const [name, type] of Object.entries({
      profile: "TEXT NOT NULL DEFAULT 'legacy'", sender_id: "TEXT", recipient_id: "TEXT",
      idempotency_key: "TEXT", request_json: "TEXT", native_state: "TEXT", expires_at: "INTEGER",
      attempted_at: "INTEGER", attempt_instance: "TEXT",
    })) {
      if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE channel_messages ADD COLUMN ${name} ${type}`);
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_native_idempotency
        ON channel_messages(sender_id, idempotency_key) WHERE profile = 'native';
      CREATE INDEX IF NOT EXISTS idx_native_queue ON channel_messages(recipient_id, native_state);
      CREATE INDEX IF NOT EXISTS idx_native_pair_rate ON channel_messages(sender_id, recipient_id, created_at) WHERE profile = 'native';
      CREATE TABLE IF NOT EXISTS channel_endpoints (agent_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_identity_notifications (
        agent_id TEXT PRIMARY KEY,
        last_name TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
    `);
    const endpointColumns = db.prepare("PRAGMA table_info(channel_endpoints)").all() as Array<{ name: string }>;
    if (!endpointColumns.some((column) => column.name === "adapter_key")) db.exec("ALTER TABLE channel_endpoints ADD COLUMN adapter_key TEXT");
    return db;
  }

  /** Never reopen an empty replacement over lost history. */
  private writable<T>(fn: () => T): T {
    this.assertHealthy();
    return fn();
  }

  private transaction<T>(fn: () => T): T {
    return this.writable(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  nativeEndpoints(): NativeEndpoint[] {
    this.assertHealthy();
    return (this.db.prepare("SELECT payload_json FROM channel_endpoints ORDER BY agent_id").all() as Array<{ payload_json: string }>)
      .map((row) => JSON.parse(row.payload_json) as NativeEndpoint);
  }

  nativeAdapterKey(agentId: string): string | undefined {
    this.assertHealthy();
    const row = this.db.prepare("SELECT adapter_key FROM channel_endpoints WHERE agent_id = ?").get(agentId) as { adapter_key: string | null } | undefined;
    return row?.adapter_key ?? undefined;
  }

  saveNativeEndpoints(endpoints: NativeEndpoint[], adapterKey?: string): void {
    this.transaction(() => {
      const insert = this.db.prepare(`INSERT INTO channel_endpoints (agent_id, payload_json, adapter_key) VALUES (?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET payload_json = excluded.payload_json, adapter_key = COALESCE(excluded.adapter_key, channel_endpoints.adapter_key)`);
      for (const endpoint of endpoints) insert.run(endpoint.agentId, JSON.stringify(endpoint), adapterKey ?? null);
    });
  }

  migrateNativeAdapterOwnership(hostId: string, oldAdapterIds: string[], newAdapterId = "codex-central"): NativeAdapterOwnershipMapping[] {
    return this.transaction(() => {
      if (!oldAdapterIds.length) return [];
      const allowed = new Set(oldAdapterIds.map((adapterId) => JSON.stringify([hostId, adapterId])));
      const targetAdapterKey = JSON.stringify([hostId, newAdapterId]);
      const rows = this.db.prepare("SELECT agent_id, payload_json, adapter_key FROM channel_endpoints WHERE adapter_key IS NOT NULL").all() as
        Array<{ agent_id: string; payload_json: string; adapter_key: string }>;
      const mappings: NativeAdapterOwnershipMapping[] = [];
      const update = this.db.prepare("UPDATE channel_endpoints SET adapter_key = ? WHERE agent_id = ? AND adapter_key = ?");
      for (const row of rows) {
        const endpoint = NativeEndpointSchema.parse(JSON.parse(row.payload_json));
        if (endpoint.hostId !== hostId || endpoint.harness !== "codex" || !allowed.has(row.adapter_key) || row.adapter_key === targetAdapterKey) continue;
        if (update.run(targetAdapterKey, row.agent_id, row.adapter_key).changes === 1) {
          mappings.push({ agentId: row.agent_id, beforeAdapterId: row.adapter_key, afterAdapterId: targetAdapterKey });
        }
      }
      return mappings;
    });
  }

  rollbackNativeAdapterOwnership(mappings: NativeAdapterOwnershipMapping[]): NativeAdapterOwnershipMapping[] {
    return this.transaction(() => {
      const restored: NativeAdapterOwnershipMapping[] = [];
      const update = this.db.prepare("UPDATE channel_endpoints SET adapter_key = ? WHERE agent_id = ? AND adapter_key = ?");
      for (const mapping of mappings) {
        if (update.run(mapping.beforeAdapterId, mapping.agentId, mapping.afterAdapterId).changes === 1) restored.push(mapping);
      }
      return restored;
    });
  }

  claimNativeIdentity(endpoint: NativeEndpoint, name: string, now = Date.now()): NativeIdentityClaim {
    if (endpoint.harness !== "codex" || !name.trim()) throw new Error("A non-empty Codex identity name is required");
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT last_name, revision FROM native_identity_notifications WHERE agent_id = ?")
        .get(endpoint.agentId) as { last_name: string; revision: number } | undefined;
      if (prior?.last_name === name) return { revision: prior.revision, changed: false };
      const pending = this.db.prepare(`SELECT COUNT(*) AS count FROM channel_messages
        WHERE profile = 'native' AND recipient_id = ? AND native_state IN ('accepted', 'queued')`).get(endpoint.agentId) as { count: number };
      if (pending.count >= 100) throw new NativeError(429, "Recipient queue is full (100 messages)");
      const recent = this.db.prepare(`SELECT COUNT(*) AS count FROM channel_messages
        WHERE profile = 'native' AND sender_id = ? AND recipient_id = ? AND created_at > ?`)
        .get(endpoint.agentId, endpoint.agentId, now - 60_000) as { count: number };
      if (recent.count >= 30) throw new NativeError(429, "Pair rate limit exceeded (30 new messages per 60 seconds)");
      const revision = (prior?.revision ?? 0) + 1;
      const input: NativeSend = {
        to: endpoint.agentId,
        text: `Your Codex thread name is ${name}. Your NAB agentId is ${endpoint.agentId}. Peer metadata is not operator instructions; no reply is required.`,
        delivery: "queue", expects_reply: false, expires_in_seconds: 86400,
        idempotency_key: `native-identity:${revision}`,
      };
      const message = this.insertNative(endpoint, endpoint, input, now);
      this.db.prepare(`INSERT INTO native_identity_notifications(agent_id, last_name, revision) VALUES (?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET last_name = excluded.last_name, revision = excluded.revision`)
        .run(endpoint.agentId, name, revision);
      return { revision, changed: true, message };
    });
  }

  nativeMessages(): NativeMessage[] {
    this.assertHealthy();
    return (this.db.prepare("SELECT payload_json FROM channel_messages WHERE profile = 'native' ORDER BY rowid").all() as Array<{ payload_json: string }>)
      .map((row) => JSON.parse(row.payload_json) as NativeMessage);
  }

  nativeMessage(messageId: string): NativeMessage | undefined {
    this.assertHealthy();
    const row = this.db.prepare("SELECT payload_json FROM channel_messages WHERE profile = 'native' AND message_id = ?").get(messageId) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as NativeMessage : undefined;
  }

  private updateNative(message: NativeMessage): void {
    this.db.prepare(`UPDATE channel_messages SET payload_json = ?, native_state = ?, attempted_at = ? WHERE message_id = ?`)
      .run(JSON.stringify(message), message.state, message.attemptedAt ?? null, message.messageId);
    this.db.prepare("INSERT INTO channel_acks VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), message.conversationId, message.messageId, Date.now(), JSON.stringify({ state: message.state, detail: message.detail }));
  }

  private insertNative(sender: NativeEndpoint, recipient: NativeEndpoint, input: NativeSend, now: number): NativeMessage {
    const request = JSON.stringify(input);
    const message: NativeMessage = {
      messageId: randomUUID(), conversationId: input.conversation_id ?? randomUUID(),
      fromAgentId: sender.agentId, toAgentId: recipient.agentId, sourceInstanceId: sender.instanceId,
      text: input.text, createdAt: now, expiresAt: now + input.expires_in_seconds * 1000,
      deliveryPolicy: input.delivery, expectsReply: input.expects_reply, inReplyTo: input.in_reply_to,
      schemaVersion: 1, state: "queued", detail: "Awaiting recipient dispatch",
    };
    this.db.prepare(`INSERT INTO channel_messages
      (message_id, conversation_id, created_at, payload_json, profile, sender_id, recipient_id, idempotency_key, request_json, native_state, expires_at)
      VALUES (?, ?, ?, ?, 'native', ?, ?, ?, ?, ?, ?)`).run(message.messageId, message.conversationId, now, JSON.stringify(message),
        sender.agentId, recipient.agentId, input.idempotency_key ?? null, request, message.state, message.expiresAt);
    return message;
  }

  acceptNative(sender: NativeEndpoint, input: NativeSend, resolveRecipient: () => NativeEndpoint, now = Date.now()): { message: NativeMessage; created: boolean } {
    return this.transaction(() => {
      const request = JSON.stringify(input);
      if (input.idempotency_key) {
        const row = this.db.prepare("SELECT payload_json, request_json FROM channel_messages WHERE profile = 'native' AND sender_id = ? AND idempotency_key = ?")
          .get(sender.agentId, input.idempotency_key) as { payload_json: string; request_json: string } | undefined;
        if (row) {
          if (row.request_json !== request) throw new NativeError(409, "Idempotency key conflicts with the original payload");
          return { message: JSON.parse(row.payload_json) as NativeMessage, created: false };
        }
      }
      const recipient = resolveRecipient();
      // Reuse the retained ledger instead of maintaining an unbounded per-pair map.
      // The transaction makes this sliding-window limit atomic and restart-safe.
      const recent = this.db.prepare(`SELECT COUNT(*) AS count FROM channel_messages
        WHERE profile = 'native' AND sender_id = ? AND recipient_id = ? AND created_at > ?`)
        .get(sender.agentId, recipient.agentId, now - 60_000) as { count: number };
      if (recent.count >= 30) throw new NativeError(429, "Pair rate limit exceeded (30 new messages per 60 seconds)");
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM channel_messages WHERE profile = 'native' AND recipient_id = ? AND native_state IN ('accepted', 'queued')")
        .get(recipient.agentId) as { count: number };
      if (count.count >= 100) throw new NativeError(429, "Recipient queue is full (100 messages)");
      let reply: NativeMessage | undefined;
      if (input.in_reply_to) {
        reply = this.nativeMessage(input.in_reply_to);
        if (!reply || reply.toAgentId !== sender.agentId || reply.fromAgentId !== recipient.agentId ||
          (input.conversation_id && input.conversation_id !== reply.conversationId)) {
          throw new NativeError(400, "Reply does not match the original participants and conversation");
        }
      }
      const message = this.insertNative(sender, recipient,
        reply && !input.conversation_id ? { ...input, conversation_id: reply.conversationId } : input, now);
      if (reply && !input.conversation_id) this.db.prepare("UPDATE channel_messages SET request_json = ? WHERE message_id = ?").run(request, message.messageId);
      if (reply) this.updateNative({ ...reply, state: "responded", detail: `Reply: ${message.messageId}` });
      return { message, created: true };
    });
  }

  attemptNative(messageId: string, instanceId: string, now = Date.now()): NativeMessage | undefined {
    return this.transaction(() => {
      const message = this.nativeMessage(messageId);
      if (message?.state !== "queued" || message.expiresAt <= now) return undefined;
      const next: NativeMessage = { ...message, state: "accepted", attemptedAt: now, detail: "Delivery attempt persisted; awaiting runtime receipt" };
      this.updateNative(next);
      this.db.prepare("UPDATE channel_messages SET attempt_instance = ? WHERE message_id = ?").run(instanceId, messageId);
      return next;
    });
  }

  receiptNative(messageId: string, instanceId: string, state: NativeMessageState, detail?: string, now = Date.now()): NativeMessage {
    // Expiry wins over a late receipt; it must not resurrect an unresolved attempt.
    this.maintainNative(now);
    return this.transaction(() => {
      const message = this.nativeMessage(messageId);
      const row = this.db.prepare("SELECT attempt_instance FROM channel_messages WHERE message_id = ?").get(messageId) as { attempt_instance: string | null } | undefined;
      if (message?.attemptedAt === undefined || row?.attempt_instance !== instanceId) throw new NativeError(409, "Receipt does not match a delivery attempt");
      if (message.state === state) return message;
      if (message.state !== "accepted" && message.state !== "held") {
        throw new NativeError(409, "Receipt conflicts with the recorded state");
      }
      const next = { ...message, state, detail };
      this.updateNative(next);
      return next;
    });
  }

  interruptNative(agentIds?: string[]): void {
    this.transaction(() => {
      for (const message of this.nativeMessages()) {
        if ((message.state === "accepted" || message.state === "held") && message.attemptedAt !== undefined && (!agentIds || agentIds.includes(message.toAgentId))) {
          this.updateNative({ ...message, state: "delivery_unknown", detail: "Connection interrupted before runtime acceptance; not retried" });
        }
      }
    });
  }

  maintainNative(now = Date.now()): void {
    this.transaction(() => {
      for (const message of this.nativeMessages()) {
        if (message.state === "queued" && message.expiresAt <= now) this.updateNative({ ...message, state: "expired", detail: "TTL elapsed before delivery" });
        if ((message.state === "accepted" || message.state === "held") && message.attemptedAt !== undefined && message.expiresAt <= now) {
          // A held runtime may release the message without another receipt. No cancellation proof exists.
          this.updateNative({ ...message, state: "delivery_unknown", detail: "TTL elapsed before runtime acceptance; not retried" });
        }
      }
      const cutoff = now - 30 * 86400_000;
      this.db.prepare("DELETE FROM channel_acks WHERE message_id IN (SELECT message_id FROM channel_messages WHERE profile = 'native' AND created_at < ?)").run(cutoff);
      this.db.prepare("DELETE FROM channel_messages WHERE profile = 'native' AND created_at < ?").run(cutoff);
    });
  }

  /** Look up an existing message by id, regardless of conversation. */
  getMessage(messageId: string): ChannelMessage | undefined {
    this.assertHealthy();
    const row = this.db.prepare(`
      SELECT payload_json
      FROM channel_messages
      WHERE profile = 'legacy' AND message_id = ?
    `).get(messageId) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as ChannelMessage) : undefined;
  }

  /** Create a new message, or return the existing one if its `messageId` is already
   *  persisted. The returned `created` flag tells the caller whether this was a fresh
   *  insert (and therefore needs to be broadcast) or a duplicate retry that the caller
   *  should silently dedup.
   *
   *  Idempotency is keyed on `messageId`. Senders that retry `POST /channel/messages`
   *  with the same explicit `messageId` will only see one broadcast and one row in
   *  `channel_messages`. */
  createMessage(input: Omit<ChannelMessage, "conversationId" | "messageId" | "createdAt"> & {
    conversationId?: string;
    messageId?: string;
    createdAt?: number;
  }): { message: ChannelMessage; created: boolean } {
    if (input.messageId) {
      const existing = this.getMessage(input.messageId);
      if (existing) return { message: existing, created: false };
    }

    const message: ChannelMessage = {
      ...input,
      conversationId: input.conversationId ?? randomUUID(),
      messageId: input.messageId ?? randomUUID(),
      createdAt: input.createdAt ?? Date.now(),
      attemptCount: input.attemptCount ?? 1,
    };

    this.writable(() =>
      this.db.prepare(`
        INSERT INTO channel_messages (message_id, conversation_id, created_at, payload_json)
        VALUES (?, ?, ?, ?)
      `).run(
        message.messageId,
        message.conversationId,
        message.createdAt,
        JSON.stringify(message),
      ),
    );

    return { message, created: true };
  }

  addAck(ack: ChannelAck): ChannelAck {
    const ackId = randomUUID();
    this.writable(() =>
      this.db.prepare(`
        INSERT INTO channel_acks (ack_id, conversation_id, message_id, timestamp, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        ackId,
        ack.conversationId,
        ack.messageId,
        ack.timestamp,
        JSON.stringify(ack),
      ),
    );
    return ack;
  }

  getConversation(conversationId: string): ChannelConversationSnapshot | undefined {
    if (this.isConversationSuppressed(conversationId)) return undefined;
    const messages = this.loadMessages(conversationId);
    if (messages.length === 0) return undefined;

    return {
      conversationId,
      messages,
      acknowledgements: this.loadAcks(conversationId),
    };
  }

  listConversations(filter?: { pendingOnly?: boolean }): ChannelConversationListEntry[] {
    this.assertHealthy();
    const rows = this.db.prepare(`
      SELECT conversation_id
      FROM channel_messages
      WHERE profile = 'legacy'
      ORDER BY created_at DESC
    `).all() as Array<{ conversation_id: string }>;

    const seen = new Set<string>();
    const entries: ChannelConversationListEntry[] = [];

    for (const row of rows) {
      if (seen.has(row.conversation_id)) continue;
      seen.add(row.conversation_id);
      if (this.isConversationSuppressed(row.conversation_id)) continue;

      const messages = this.loadMessages(row.conversation_id);
      if (messages.length === 0) continue;
      const acknowledgements = this.loadAcks(row.conversation_id);
      const entry = this.summarizeConversation(row.conversation_id, messages, acknowledgements);

      if (filter?.pendingOnly && !entry.pendingReply) continue;

      entries.push(entry);
    }

    return entries;
  }

  /** Delete every conversation whose most recent message is older than `cutoff`
   *  (a timestamp in ms). Removes the corresponding rows from `channel_messages`,
   *  `channel_acks`, and `channel_suppressed_conversations`. Returns the number
   *  of conversations deleted, for logging.
   *
   *  Used by the registry's hourly maintenance sweep to bound SQLite growth on
   *  long-running registries. Conversations actively used keep their `created_at`
   *  refreshed via every new inbound message, so the cutoff effectively measures
   *  "time since last activity". */
  deleteConversationsOlderThan(cutoff: number): number {
    this.assertHealthy();
    const stale = this.db.prepare(`
      SELECT conversation_id, MAX(created_at) AS last_activity
      FROM channel_messages
      WHERE profile = 'legacy'
      GROUP BY conversation_id
      HAVING last_activity < ?
    `).all(cutoff) as Array<{ conversation_id: string }>;

    if (stale.length === 0) return 0;

    this.writable(() => {
      const deleteMessages = this.db.prepare(`DELETE FROM channel_messages WHERE profile = 'legacy' AND conversation_id = ?`);
      const deleteAcks = this.db.prepare(`DELETE FROM channel_acks WHERE conversation_id = ? AND message_id NOT IN (SELECT message_id FROM channel_messages WHERE profile = 'native')`);
      const deleteSuppressed = this.db.prepare(`DELETE FROM channel_suppressed_conversations WHERE conversation_id = ?`);
      for (const row of stale) {
        deleteMessages.run(row.conversation_id);
        deleteAcks.run(row.conversation_id);
        deleteSuppressed.run(row.conversation_id);
      }
    });
    return stale.length;
  }

  /** Delete conversations that have reached a TERMINAL status (`answered` or
   *  `failed`) and whose last activity is older than `cutoff`. Keeps the store
   *  (and therefore every agent's inbox + the per-call scan) small so a burst of
   *  handled traffic never buries or stalls fresh messages. Returns the count.
   *
   *  Distinct from `deleteConversationsOlderThan` (a long retention backstop):
   *  this targets already-resolved threads on a much shorter horizon. */
  deleteTerminalConversationsOlderThan(cutoff: number): number {
    const candidates: string[] = [];
    for (const entry of this.listConversations()) {
      if (entry.status !== "answered" && entry.status !== "failed") continue;
      if ((entry.lastMessage?.createdAt ?? 0) >= cutoff) continue;
      candidates.push(entry.conversationId);
    }
    if (candidates.length === 0) return 0;

    this.writable(() => {
      const deleteMessages = this.db.prepare(`DELETE FROM channel_messages WHERE profile = 'legacy' AND conversation_id = ?`);
      const deleteAcks = this.db.prepare(`DELETE FROM channel_acks WHERE conversation_id = ? AND message_id NOT IN (SELECT message_id FROM channel_messages WHERE profile = 'native')`);
      const deleteSuppressed = this.db.prepare(`DELETE FROM channel_suppressed_conversations WHERE conversation_id = ?`);
      for (const id of candidates) {
        deleteMessages.run(id);
        deleteAcks.run(id);
        deleteSuppressed.run(id);
      }
    });
    return candidates.length;
  }

  /** Find messages that are awaiting a reply but whose `expiresAt` deadline has
   *  passed without ever receiving a terminal ack (`answered` or `failed`). Used
   *  by the registry's ack sweeper to mark stuck conversations as failed and
   *  notify subscribers, instead of letting them sit in `pending` forever. */
  findExpiredAwaitingReply(now: number): ChannelMessage[] {
    const expired: ChannelMessage[] = [];
    const entries = this.listConversations();
    for (const entry of entries) {
      if (!entry.expired) continue;
      const messages = this.loadMessages(entry.conversationId);
      const acks = this.loadAcks(entry.conversationId);
      const latestAckByMessage = new Map<string, ChannelAck>();
      for (const ack of acks) latestAckByMessage.set(ack.messageId, ack);
      for (const msg of messages) {
        if (!msg.expectsResponse) continue;
        if (typeof msg.expiresAt !== "number" || msg.expiresAt > now) continue;
        const lastAck = latestAckByMessage.get(msg.messageId);
        if (lastAck?.state === "answered" || lastAck?.state === "failed") continue;
        expired.push(msg);
      }
    }
    return expired;
  }

  retryMessage(conversationId: string, messageId: string): ChannelMessage | undefined {
    this.assertHealthy();
    const row = this.db.prepare(`
      SELECT payload_json
      FROM channel_messages
      WHERE profile = 'legacy' AND conversation_id = ? AND message_id = ?
    `).get(conversationId, messageId) as { payload_json: string } | undefined;

    if (!row) return undefined;

    const current = JSON.parse(row.payload_json) as ChannelMessage;
    const retried: ChannelMessage = {
      ...current,
      attemptCount: (current.attemptCount ?? 1) + 1,
      createdAt: Date.now(),
    };

    const result = this.writable(() =>
      this.db.prepare(`
        UPDATE channel_messages
        SET created_at = ?, payload_json = ?
        WHERE profile = 'legacy' AND message_id = ?
      `).run(retried.createdAt, JSON.stringify(retried), messageId),
    );
    // Report a missing row rather than a successful retry.
    if (Number(result.changes ?? 0) === 0) return undefined;

    return retried;
  }

  suppressConversation(conversationId: string): boolean {
    this.assertHealthy();
    const exists = this.db.prepare(`
      SELECT 1
      FROM channel_messages
      WHERE profile = 'legacy' AND conversation_id = ?
      LIMIT 1
    `).get(conversationId);
    if (!exists) return false;

    this.writable(() =>
      this.db.prepare(`
        INSERT OR REPLACE INTO channel_suppressed_conversations (conversation_id, suppressed_at)
        VALUES (?, ?)
      `).run(conversationId, Date.now()),
    );
    return true;
  }

  reviveConversation(conversationId: string): boolean {
    const result = this.writable(() =>
      this.db.prepare(`
        DELETE FROM channel_suppressed_conversations
        WHERE conversation_id = ?
      `).run(conversationId),
    );
    return Number(result.changes ?? 0) > 0;
  }

  isConversationSuppressed(conversationId: string): boolean {
    this.assertHealthy();
    const row = this.db.prepare(`
      SELECT 1
      FROM channel_suppressed_conversations
      WHERE conversation_id = ?
      LIMIT 1
    `).get(conversationId);
    return Boolean(row);
  }

  private loadMessages(conversationId: string): ChannelMessage[] {
    const rows = this.db.prepare(`
      SELECT payload_json
      FROM channel_messages
      WHERE profile = 'legacy' AND conversation_id = ?
      ORDER BY created_at ASC
    `).all(conversationId) as Array<{ payload_json: string }>;

    return rows.map((row) => JSON.parse(row.payload_json) as ChannelMessage);
  }

  private loadAcks(conversationId: string): ChannelAck[] {
    const rows = this.db.prepare(`
      SELECT payload_json
      FROM channel_acks
      WHERE conversation_id = ? AND message_id NOT IN (SELECT message_id FROM channel_messages WHERE profile = 'native')
      ORDER BY timestamp ASC
    `).all(conversationId) as Array<{ payload_json: string }>;

    return rows.map((row) => JSON.parse(row.payload_json) as ChannelAck);
  }

  private summarizeConversation(
    conversationId: string,
    messages: ChannelMessage[],
    acknowledgements: ChannelAck[],
  ): ChannelConversationListEntry {
    const now = Date.now();
    const lastMessage = messages[messages.length - 1]!;
    const latestAckByMessage = new Map<string, ChannelAck>();

    for (const ack of acknowledgements) {
      latestAckByMessage.set(ack.messageId, ack);
    }

    const pendingMessages = messages.filter((message) => {
      if (!message.expectsResponse) return false;
      const lastAck = latestAckByMessage.get(message.messageId);
      return lastAck?.state !== "answered" && lastAck?.state !== "failed";
    });

    const expired = pendingMessages.some(
      (message) => typeof message.expiresAt === "number" && message.expiresAt <= now,
    );
    const pendingReply = pendingMessages.length > 0 && !expired;
    const lastAckState = acknowledgements.length > 0
      ? acknowledgements[acknowledgements.length - 1]!.state
      : undefined;

    let status: ChannelConversationListEntry["status"] = "active";
    if (expired) status = "expired";
    else if (pendingMessages.length > 0) status = "pending";
    else if (lastAckState === "failed") status = "failed";
    else if (lastAckState === "answered") status = "answered";

    return {
      conversationId,
      lastMessage,
      pendingReply,
      expired,
      lastAckState,
      pendingCount: pendingMessages.length,
      pendingMessageIds: pendingMessages.map((message) => message.messageId),
      status,
    };
  }
}
