import { randomUUID } from "node:crypto";
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

export const LIST_AGENTS_SCHEMA = { type: "object", properties: {}, additionalProperties: false } as const;
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
    name: "list_agents", label: "List agents", description: "List reachable native NAB peers.", parameters: LIST_AGENTS_SCHEMA,
    async execute() {
      const fetched = await brokerRequest<{ agents: NativeEndpoint[] }>(baseUrl(), "/native/agents");
      const peers = fetched.agents.filter((peer) => peer.agentId !== agentId && peer.reachable);
      return { content: [{ type: "text", text: peers.length ? peers.map((p) => `${p.displayName}\t${p.agentId}\t${p.harness}\t${p.state}`).join("\n") : "No peers available." }], details: { peers } };
    },
  });

  pi.registerTool({
    name: "send_message", label: "Send message", description: "Send text to an exact native NAB agent ID.", parameters: SEND_MESSAGE_SCHEMA,
    async execute(_id, params) {
      if (!agentId) throw new Error("NAB session binding is not initialized");
      const result = await sendMessage(baseUrl(), agentId, {
        to: params.to, text: params.text, conversation_id: params.conversation_id, in_reply_to: params.in_reply_to,
        delivery: params.delivery || "auto", expects_reply: params.expects_reply ?? false, expires_in_seconds: 600, idempotency_key: randomUUID(),
      });
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
