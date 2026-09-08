import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { brokerRequest, sendMessage } from "./host-link.js";

export async function runNativeMcp() {
  const base = process.env.NAB_BROKER_URL;
  const binding = process.env.NAB_BINDING_FILE;
  if (!base || !binding) throw new Error("NAB_BROKER_URL and NAB_BINDING_FILE are required");
  const sender = async () => {
    const value = JSON.parse(await readFile(binding, "utf8"));
    if (typeof value.agentId !== "string") throw new Error("Runtime session is not bound yet");
    return value.agentId as string;
  };
  const server = new McpServer({ name: "native-agent-broker", version: "0.1.0" });
  const result = async (action: () => Promise<unknown>) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await action()) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "NAB tool failed" }] }; }
  };
  server.tool("list_agents", "List reachable NAB sessions. Offline history is not an active agent.", {
    harness: z.enum(["claude", "codex", "pi"]).optional(), include_offline: z.boolean().optional(), query: z.string().optional(),
  }, (args) => result(async () => {
    const query = new URLSearchParams();
    if (args.harness) query.set("harness", args.harness);
    if (args.include_offline) query.set("include_offline", "true");
    if (args.query) query.set("query", args.query);
    return brokerRequest(base, `/native/agents?${query}`, await sender());
  }));
  server.tool("send_message", "Send to one existing NAB session. Acceptance is not a model response. Reply explicitly with in_reply_to; terminal ACKs need no reply.", {
    to: z.string(), text: z.string(), conversation_id: z.string().optional(), in_reply_to: z.string().optional(),
    delivery: z.enum(["auto", "steer", "queue"]).optional(), expects_reply: z.boolean().optional(), expires_in_seconds: z.number().int().min(1).max(86400).optional(),
  }, (args) => result(async () => sendMessage(base, await sender(), args)));
  await server.connect(new StdioServerTransport());
}
