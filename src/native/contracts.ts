import { z } from "zod";

const identifier = z.string().min(1).max(512);
export const NativeHarnessSchema = z.enum(["claude", "codex", "pi"]);
export const NativeAgentStateSchema = z.enum([
  "starting", "idle", "active", "awaiting_approval", "disconnected", "stopped", "error", "unknown",
]);
export const NativeCapabilitiesSchema = z.object({
  receiveIdle: z.boolean(),
  receiveBusy: z.enum(["steer", "queue", "unsupported"]),
});
export const NativeEndpointSchema = z.object({
  agentId: identifier,
  hostId: identifier,
  instanceId: identifier,
  harness: NativeHarnessSchema,
  displayName: identifier,
  nativeSessionId: identifier,
  state: NativeAgentStateSchema,
  reachable: z.boolean(),
  capabilities: NativeCapabilitiesSchema,
});
export type NativeEndpoint = z.infer<typeof NativeEndpointSchema>;

// Tuple encoding avoids collisions between host, harness and native session IDs.
export function nativeAgentId(hostId: string, harness: NativeEndpoint["harness"], nativeSessionId: string): string {
  return `nab:${[hostId, harness, nativeSessionId].map(encodeURIComponent).join(":")}`;
}

export const NativeSendSchema = z.object({
  to: identifier,
  text: z.string().min(1).refine((text) => Buffer.byteLength(text, "utf8") <= 256 * 1024, "Text exceeds 256 KiB"),
  conversation_id: identifier.optional(),
  in_reply_to: identifier.optional(),
  delivery: z.enum(["auto", "steer", "queue"]).default("auto"),
  expects_reply: z.boolean().default(false),
  expires_in_seconds: z.number().int().min(1).max(86400).default(600),
  idempotency_key: identifier.optional(),
}).strict();
export type NativeSend = z.infer<typeof NativeSendSchema>;
export const NativeMessageStateSchema = z.enum([
  "accepted", "queued", "runtime_accepted", "held", "responded", "failed", "expired", "delivery_unknown",
]);
export type NativeMessageState = z.infer<typeof NativeMessageStateSchema>;
export const NativeMessageSchema = z.object({
  messageId: identifier,
  conversationId: identifier,
  fromAgentId: identifier,
  toAgentId: identifier,
  sourceInstanceId: identifier,
  text: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  deliveryPolicy: z.enum(["auto", "steer", "queue"]),
  expectsReply: z.boolean(),
  inReplyTo: identifier.optional(),
  schemaVersion: z.literal(1),
  state: NativeMessageStateSchema,
  detail: z.string().optional(),
  attemptedAt: z.number().optional(),
});
export type NativeMessage = z.infer<typeof NativeMessageSchema>;
export const NativeRegisterSchema = z.object({
  type: z.literal("native.register"),
  adapterId: identifier.optional(),
  hostId: identifier,
  instanceId: identifier,
  endpoints: z.array(NativeEndpointSchema).max(1000),
});
export const NativeClientFrameSchema = z.discriminatedUnion("type", [
  NativeRegisterSchema,
  z.object({ type: z.literal("native.heartbeat"), hostId: identifier, adapterId: identifier.optional() }),
  z.object({
    type: z.literal("native.receipt"),
    messageId: identifier,
    state: z.enum(["runtime_accepted", "held", "failed", "delivery_unknown"]),
    detail: z.string().max(2048).optional(),
  }),
]);
export type NativeClientFrame = z.infer<typeof NativeClientFrameSchema>;
export type NativeServerFrame =
  | { type: "native.roster"; agents: NativeEndpoint[] }
  | { type: "native.deliver"; message: NativeMessage }
  | { type: "native.error"; error: string };

export class NativeError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: { code: string; limit_bytes?: number; actual_bytes?: number; notification?: "skipped" | "queued" | "deduplicated" | "failed" }) {
    super(message);
  }
}
