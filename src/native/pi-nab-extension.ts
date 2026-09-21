import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { nativeAgentId, type NativeEndpoint, type NativeMessage } from "./contracts.js";
import { brokerRequest, HostLink, peerText, sendMessage } from "./host-link.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: unknown };
type SessionEntry = { type?: string; customType?: string; details?: unknown; message?: { customType?: string; details?: unknown } };
type ExtensionContext = {
  sessionManager: { getSessionId(): string; getEntries(): SessionEntry[] };
  ui: { setStatus(key: string, value: string): void };
};
type ExtensionAPI = {
  registerTool(tool: { name: string; label: string; description: string; parameters: unknown; execute(id: string, params: any): Promise<ToolResult> }): void;
  sendMessage(message: { customType: string; content: string; display: boolean; details: unknown }, options: { triggerTurn: boolean; deliverAs: "steer" | "followUp" }): void;
  on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => Promise<void>): void;
  on(event: "session_shutdown" | "agent_start" | "agent_end", handler: (event: unknown, ctx: ExtensionContext) => Promise<void>): void;
};

const CUSTOM_TYPE = "peer";
const baseUrl = () => (process.env.NAB_BROKER_URL || "http://127.0.0.1:4999").replace(/\/$/, "") + "/";

/** Supervisor state for the agents under ~/agents. Absent on hosts that do not
 * run them, in which case the roster is unrestricted, exactly as before. */
const REGISTRY_PATH = process.env.PI_AGENT_REGISTRY || join(homedir(), "agents/.runtime/agents.json");
const AGENT_CTL = process.env.PI_AGENT_CTL || join(homedir(), ".local/bin/pi-agent-ctl");
const WAKE_TIMEOUT_MS = 120_000;

export type RegistryEntry = { name: string; agentId: string; dir: string; sees?: string[] };

/** Registered agents keyed by agentId, or undefined when there is no registry
 * at all. Undefined and empty mean different things: no registry is "do not
 * filter", an empty one is "nothing is visible". */
export async function readRegistry(path = REGISTRY_PATH): Promise<Map<string, RegistryEntry> | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as {
      agents?: Record<string, { agentId?: unknown; dir?: unknown; sees?: unknown }>;
    };
    const entries = new Map<string, RegistryEntry>();
    for (const [name, value] of Object.entries(parsed.agents ?? {})) {
      if (typeof value?.agentId === "string") {
        entries.set(value.agentId, {
          name, agentId: value.agentId, dir: String(value.dir ?? ""),
          sees: Array.isArray(value.sees) ? value.sees.map(String) : undefined,
        });
      }
    }
    return entries;
  } catch {
    // A half-written registry must not silently widen the roster.
    return new Map();
  }
}

/** The peers one agent may see, or undefined when it may see them all.
 *
 * The list is per agent and directional: a naming b does not let b see a. An
 * entry with no list sees everyone, so registering a peer never silently cuts
 * anyone off. */
export function allowedNames(
  registry: Map<string, RegistryEntry> | undefined,
  selfAgentId: string,
): Set<string> | undefined {
  const sees = registry?.get(selfAgentId)?.sees;
  return sees ? new Set(sees) : undefined;
}

export type RosterRow = { name: string; agentId: string; state: "working" | "idle" | "sleeping"; harness: string };

/** Merge the live endpoints with the registry.
 *
 * Three states, all derived: the broker knows who is running, the registry
 * knows who exists. An agent in the registry but not in the roster is asleep —
 * it still has an address and can be woken, so it belongs on the list. */
export function buildRoster(
  live: NativeEndpoint[],
  registry: Map<string, RegistryEntry> | undefined,
  selfAgentId: string,
): RosterRow[] {
  const allowed = allowedNames(registry, selfAgentId);
  const visible = (entry: RegistryEntry | undefined) => !allowed || (entry !== undefined && allowed.has(entry.name));

  const rows: RosterRow[] = [];
  const seen = new Set<string>();
  for (const peer of live) {
    if (peer.agentId === selfAgentId || !peer.reachable) continue;
    const entry = registry?.get(peer.agentId);
    if (registry && !entry) continue;
    if (!visible(entry)) continue;
    seen.add(peer.agentId);
    rows.push({
      name: entry?.name ?? peer.displayName,
      agentId: peer.agentId,
      state: peer.state === "active" ? "working" : "idle",
      harness: peer.harness,
    });
  }
  for (const entry of registry?.values() ?? []) {
    if (entry.agentId === selfAgentId || seen.has(entry.agentId) || !visible(entry)) continue;
    rows.push({ name: entry.name, agentId: entry.agentId, state: "sleeping", harness: "pi" });
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

/** Start a sleeping agent and wait for it to register. */
function wakeAgent(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(AGENT_CTL, ["wake", name], { timeout: WAKE_TIMEOUT_MS }, (error) => {
      error ? reject(new Error(`could not wake ${name}: ${error.message}`)) : resolve();
    });
  });
}

export const LIST_AGENTS_SCHEMA = {
  type: "object",
  properties: {
    scope: {
      type: "string",
      enum: ["agents", "all"],
      description: "'agents' (default) lists your fellow agents; 'all' also lists unrelated sessions on this host.",
    },
  },
  additionalProperties: false,
} as const;
export const SEND_MESSAGE_SCHEMA = {
  type: "object",
  properties: {
    to: { type: "string", minLength: 1, description: "Exact target agentId from list_agents" },
    text: { type: "string", minLength: 1, maxLength: 65536 },
    conversation_id: { type: "string", minLength: 1 },
    in_reply_to: { type: "string", minLength: 1 },
    delivery: { type: "string", enum: ["auto", "steer", "queue"] },
    expects_reply: { type: "boolean" },
  },
  required: ["to", "text"],
  additionalProperties: false,
} as const;

function messageIdFrom(entry: SessionEntry): string | undefined {
  const candidate = entry.customType === CUSTOM_TYPE ? entry.details : entry.message?.customType === CUSTOM_TYPE ? entry.message.details : undefined;
  if (!candidate || typeof candidate !== "object") return undefined;
  const id = (candidate as { messageId?: unknown }).messageId;
  return typeof id === "string" ? id : undefined;
}

export function deliveryMode(message: Pick<NativeMessage, "deliveryPolicy">, active: boolean): "steer" | "followUp" {
  return active && message.deliveryPolicy === "queue" ? "followUp" : "steer";
}

export default function nabPiExtension(pi: ExtensionAPI) {
  const hostId = process.env.NAB_HOST_ID || "local";
  const displayName = process.env.NAB_AGENT_NAME || "Pi";
  let agentId = "";
  let nativeSessionId = "";
  let link: HostLink | undefined;
  let endpoint: NativeEndpoint | undefined;
  let active = false;
  const delivered = new Set<string>();
  const pending = new Map<string, NativeMessage>();

  function publishState(state: "idle" | "active") {
    if (!link || !endpoint) return;
    endpoint = { ...endpoint, state };
    link.update([endpoint]);
  }

  pi.registerTool({
    name: "list_agents", label: "List agents",
    description: "List the agents you can message. Each is working (mid-task), idle, or sleeping. Sleeping agents are reachable exactly like the others — send_message wakes them for you.",
    parameters: LIST_AGENTS_SCHEMA,
    async execute(_id, params) {
      const fetched = await brokerRequest<{ agents: NativeEndpoint[] }>(baseUrl(), "/native/agents");
      const registry = params?.scope === "all" ? undefined : await readRegistry();
      const peers = buildRoster(fetched.agents, registry, agentId);
      return {
        content: [{ type: "text", text: peers.length ? peers.map((p) => `${p.name}\t${p.agentId}\t${p.harness}\t${p.state}`).join("\n") : "No peers available." }],
        details: { peers },
      };
    },
  });

  pi.registerTool({
    name: "send_message", label: "Send message", description: "Send text to an exact native NAB agent ID.", parameters: SEND_MESSAGE_SCHEMA,
    async execute(_id, params) {
      if (!agentId) throw new Error("NAB session binding is not initialized");

      // Listing and sending have to agree: an agent that cannot see a peer
      // must not reach it by quoting an agentId it learned elsewhere.
      const registry = await readRegistry();
      const allowed = allowedNames(registry, agentId);
      if (allowed) {
        const target = registry?.get(params.to);
        if (!target || !allowed.has(target.name)) {
          throw new Error(`${params.to} is not among the agents you can message; call list_agents for the ones you can`);
        }
      }

      const send = () => sendMessage(baseUrl(), agentId, {
        to: params.to, text: params.text, conversation_id: params.conversation_id, in_reply_to: params.in_reply_to,
        delivery: params.delivery || "auto", expects_reply: params.expects_reply ?? false, expires_in_seconds: 600, idempotency_key: randomUUID(),
      });

      let result: Awaited<ReturnType<typeof sendMessage>>;
      try {
        result = await send();
      } catch (error) {
        // A sleeping agent is not an error the caller should have to handle:
        // start it and deliver. Waking is silent by design, so sending looks
        // the same whether the recipient was up or not.
        const entry = registry?.get(params.to);
        if (!entry) throw error;
        await wakeAgent(entry.name);
        result = await send();
      }
      return { content: [{ type: "text", text: `Accepted by broker: conversation=${result.conversationId} message=${result.messageId}` }], details: result };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    link?.stop();
    delivered.clear();
    for (const entry of ctx.sessionManager.getEntries()) {
      const id = messageIdFrom(entry);
      if (id) delivered.add(id);
    }
    nativeSessionId = ctx.sessionManager.getSessionId();
    agentId = nativeAgentId(hostId, "pi", nativeSessionId);
    link = new HostLink(baseUrl(), hostId, `pi:${nativeSessionId}`);
    endpoint = {
      agentId, hostId, instanceId: link.instanceId, harness: "pi", displayName, nativeSessionId,
      state: active ? "active" : "idle", reachable: true, capabilities: { receiveIdle: true, receiveBusy: "steer" },
    };
    link.onDeliver = async (message) => {
      if (message.toAgentId !== agentId) return;
      if (delivered.has(message.messageId)) {
        link?.receipt(message.messageId, "runtime_accepted", "Duplicate already present in Pi session");
        return;
      }
      const mode = deliveryMode(message, active);
      if (mode === "followUp") pending.set(message.messageId, message);
      delivered.add(message.messageId);
      try {
        pi.sendMessage({
          customType: CUSTOM_TYPE, content: peerText(message), display: true,
          details: { messageId: message.messageId, conversationId: message.conversationId, fromAgentId: message.fromAgentId, inReplyTo: message.inReplyTo },
        }, { triggerTurn: true, deliverAs: mode });
        link?.receipt(message.messageId, mode === "followUp" ? "held" : "runtime_accepted", `pi.sendMessage customType=peer; triggerTurn=true; deliverAs=${mode}`);
      } catch (error) {
        delivered.delete(message.messageId);
        throw error;
      }
    };
    link.update([endpoint]);
    link.start();
    ctx.ui.setStatus("nab", `NAB ${displayName} · ${nativeSessionId}`);
  });

  pi.on("agent_start", async () => { active = true; publishState("active"); });
  pi.on("agent_end", async () => {
    active = false;
    publishState("idle");
    for (const message of pending.values()) link?.receipt(message.messageId, "runtime_accepted", "Queued Pi peer message released at agent_end");
    pending.clear();
  });
  pi.on("session_shutdown", async () => {
    link?.stop();
    link = undefined;
    endpoint = undefined;
    pending.clear();
    active = false;
  });
}
