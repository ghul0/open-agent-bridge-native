import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NativeEndpointSchema, nativeAgentId, type NativeEndpoint } from "./contracts.js";
import { brokerRequest, sendMessage } from "./host-link.js";

type ToolExtra = { _meta?: Record<string, unknown> };
type Fetch = typeof fetch;

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function resolveNativeMcpSender(
  extra: ToolExtra,
  hostId: string,
  base: string,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const threadId = extra._meta?.threadId;
  if (typeof threadId !== "string" || !canonicalUuid.test(threadId)) {
    throw new Error("Codex tool call is missing a canonical _meta.threadId");
  }
  const expectedAgentId = nativeAgentId(hostId, "codex", threadId);
  const query = new URLSearchParams({ include_offline: "true", harness: "codex", query: expectedAgentId });
  const response = await fetchImpl(new URL(`/native/agents?${query}`, base));
  if (!response.ok) throw new Error(`NAB agent lookup failed (${response.status})`);
  const body = await response.json() as { agents?: unknown[] };
  const agents = Array.isArray(body.agents)
    ? body.agents.map((value) => NativeEndpointSchema.safeParse(value)).filter((value) => value.success).map((value) => value.data)
    : [];
  const matches = agents.filter((agent: NativeEndpoint) => agent.agentId === expectedAgentId && agent.nativeSessionId === threadId &&
    agent.hostId === hostId && agent.harness === "codex" && agent.reachable);
  if (matches.length !== 1) throw new Error("Codex thread is not registered as one reachable NAB agent");
  return expectedAgentId;
}

export function registerNativeMcpTools(server: McpServer, base: string, hostId: string, fetchImpl: Fetch = fetch): void {
  const sender = (extra: ToolExtra) => resolveNativeMcpSender(extra, hostId, base, fetchImpl);
  const result = async (action: () => Promise<unknown>) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await action()) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "NAB tool failed" }] }; }
  };
  server.tool("list_agents", "List reachable NAB sessions. Offline history is not an active agent.", {
    harness: z.enum(["claude", "codex", "pi"]).optional(), include_offline: z.boolean().optional(), query: z.string().optional(),
  }, (args, extra) => result(async () => {
    const query = new URLSearchParams();
    if (args.harness) query.set("harness", args.harness);
    if (args.include_offline) query.set("include_offline", "true");
    if (args.query) query.set("query", args.query);
    const agentId = await sender(extra);
    const roster = await brokerRequest<{ agents: NativeEndpoint[] }>(base, `/native/agents?${query}`, agentId);
    const own = await brokerRequest<{ agents: NativeEndpoint[] }>(base, `/native/agents?query=${encodeURIComponent(agentId)}`, agentId);
    const self = own.agents.find((agent) => agent.agentId === agentId);
    return { ...roster, self };
  }));
  server.tool("send_message", "Send to one existing NAB session. Acceptance is not a model response. Reply explicitly with in_reply_to; terminal ACKs need no reply.", {
    to: z.string(), text: z.string(), conversation_id: z.string().optional(), in_reply_to: z.string().optional(),
    delivery: z.enum(["auto", "steer", "queue"]).optional(), expects_reply: z.boolean().optional(), expires_in_seconds: z.number().int().min(1).max(86400).optional(),
  }, (args, extra) => result(async () => sendMessage(base, await sender(extra), args)));
}

export async function runNativeMcp() {
  const base = process.env.NAB_BROKER_URL;
  const hostId = process.env.NAB_HOST_ID;
  if (!base || !hostId) throw new Error("NAB_BROKER_URL and NAB_HOST_ID are required");
  const server = new McpServer({ name: "native-agent-broker", version: "0.1.0" });
  registerNativeMcpTools(server, base, hostId);
  await server.connect(new StdioServerTransport());
}
