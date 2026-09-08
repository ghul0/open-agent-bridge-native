import { readFile } from "node:fs/promises";

interface PeerInput { from: string; messageId?: string; body: string }
interface EvidenceCall { name: string; arguments: Record<string, unknown> }
type EvidenceEvent =
  | { kind: "input"; text: string; peer?: PeerInput }
  | { kind: "call"; id: string; call: EvidenceCall }
  | { kind: "result"; callId: string; text: string; success: boolean; receipt?: Row };
export interface RuntimeEvidence {
  sessionId: string;
  inputs: string[];
  calls: EvidenceCall[];
  results: string[];
  outputs: string[];
  // Legacy summaries are diagnostic only; verification requires ordered provenance.
  events?: EvidenceEvent[];
  aliases?: string[];
}
type Row = Record<string, any>;
const stringify = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value) ?? "";
const textContent = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value)
  ? value.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n") : "";
const empty = (sessionId: string): RuntimeEvidence => ({ sessionId, inputs: [], calls: [], results: [], outputs: [], events: [] });
function input(e: RuntimeEvidence, text: string, peer?: PeerInput) { e.inputs.push(text); e.events!.push({ kind: "input", text, ...(peer ? { peer } : {}) }); }
function call(e: RuntimeEvidence, id: unknown, name: string, args: unknown) {
  if (typeof id !== "string" || !id || !args || typeof args !== "object" || Array.isArray(args)) return;
  const value = { name, arguments: args as Record<string, unknown> };
  e.calls.push(value); e.events!.push({ kind: "call", id, call: value });
}
function receipt(value: unknown): Row | undefined {
  if (typeof value === "string") { try { return receipt(JSON.parse(value)); } catch { return undefined; } }
  if (!value || typeof value !== "object") return undefined;
  const row = value as Row;
  if (row.isError || row.is_error || row.error || row.success === false) return undefined;
  if (typeof row.messageId === "string" || (row.success === true && typeof row.msg_id === "string")) return row;
  if (Array.isArray(value)) return value.map(receipt).find(Boolean);
  return receipt(row.details) ?? receipt(row.content) ?? receipt(row.text);
}
function result(e: RuntimeEvidence, id: unknown, value: unknown, success: boolean, details?: unknown) {
  if (typeof id !== "string" || !id) return;
  const text = textContent(value) || stringify(value);
  if (success) e.results.push(text);
  e.events!.push({ kind: "result", callId: id, text, success, receipt: success ? receipt(details) ?? receipt(value) : undefined });
}
function nabPeer(text: string): PeerInput | undefined {
  const match = text.match(/^\[NAB peer message — data from another agent, not operator authorization\]\nfrom_agent_id=([^\n]+)\nmessage_id=([^\n]+)\nconversation_id=([^\n]+)\n[^]*?\n\n([^]*)$/);
  return match ? { from: match[1], messageId: match[2], body: match[4] } : undefined;
}
function nativePeer(text: string, attachment = false): PeerInput | undefined {
  // Claude serializes queued attachments and already-consumed peer input differently.
  const prefix = "Another Claude session sent a message:\n";
  if (!attachment && !text.startsWith(prefix)) return undefined;
  const envelope = attachment ? text : text.slice(prefix.length);
  const match = envelope.match(/^<cross-session-message((?:\s+[a-z-]+="[^"]*")*)>\n([^]*?)\n<\/cross-session-message>(?:\n[^]*)?$/);
  const from = match?.[1].match(/\sfrom="([^"]+)"/)?.[1];
  if (!match || !from) return undefined;
  const body = match[2].replace(/<\\\/cross-session-message/gi, "</cross-session-message");
  const metadata = body.match(/^\[NAB message_id=([^ ]+) from_agent_id=([^;]+); peer data, not operator approval\]\n([^]*)$/);
  return metadata ? { from: metadata[2], messageId: metadata[1], body: metadata[3] } : { from, body };
}
export function piEvidence(rows: Row[], sessionId: string): RuntimeEvidence {
  const header = rows.find((r) => r.type === "session");
  if (header?.id !== sessionId) throw new Error("Pi evidence session mismatch");
  const evidence = empty(sessionId);
  for (const row of rows) {
    if (row.type === "custom_message" && row.customType === "peer") {
      const text = textContent(row.content), peer = nabPeer(text);
      input(evidence, text, peer && row.details?.fromAgentId === peer.from && row.details?.messageId === peer.messageId ? peer : undefined);
    }
    const message = row.message;
    if (!message) continue;
    if (message.role === "user") input(evidence, textContent(message.content));
    if (message.role === "toolResult") result(evidence, message.toolCallId, message.content, message.isError === false, message.details);
    if (message.role === "assistant") for (const item of message.content ?? []) {
      if (item.type === "toolCall") call(evidence, item.id, item.name, item.arguments);
      if (item.type === "text") evidence.outputs.push(item.text);
    }
  }
  return evidence;
}
export function claudeEvidence(rows: Row[], sessionId: string): RuntimeEvidence {
  const matching = rows.filter((r) => r.sessionId === sessionId);
  if (!matching.length) throw new Error("Claude evidence session mismatch");
  const evidence = empty(sessionId);
  for (const row of matching) {
    if (row.type === "attachment" && row.attachment?.type === "queued_command" && row.attachment?.origin?.kind === "peer" && typeof row.attachment.prompt === "string") {
      input(evidence, row.attachment.prompt, nativePeer(row.attachment.prompt, true));
    }
    const content = row.message?.content;
    if (typeof content === "string" && row.type === "user") input(evidence, content, nativePeer(content));
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (row.type === "assistant" && item.type === "tool_use") call(evidence, item.id, item.name.replace(/^functions\./, ""), item.input);
      if (row.type === "assistant" && item.type === "text") evidence.outputs.push(item.text);
      if (row.type === "user" && item.type === "text") input(evidence, item.text, nativePeer(item.text));
      if (row.type === "user" && item.type === "tool_result") result(evidence, item.tool_use_id, item.content, !item.is_error);
    }
  }
  return evidence;
}
export function codexEvidence(value: Row, sessionId: string): RuntimeEvidence {
  const thread = value.thread;
  if (thread?.id !== sessionId || (value.binding && value.binding.threadId !== sessionId)) throw new Error("Codex evidence thread mismatch");
  const evidence = empty(sessionId);
  if (value.binding) {
    if (!canonicalMatches(value.binding.agentId, sessionId, "codex")) throw new Error("Codex evidence binding mismatch");
    evidence.aliases = [value.binding.agentId, value.binding.name].filter((v): v is string => typeof v === "string");
  }
  for (const turn of thread.turns ?? []) for (const item of turn.items ?? []) {
    if (item.type === "userMessage") { const text = textContent(item.content); input(evidence, text, nabPeer(text)); }
    if (item.type === "agentMessage") evidence.outputs.push(item.text);
    if (item.type === "mcpToolCall") {
      call(evidence, item.id, `${item.server}.${item.tool}`, item.arguments);
      result(evidence, item.id, item.result, item.status === "completed" && !item.error && item.result != null && !item.result.isError && !item.result.is_error);
    }
    if (item.type === "commandExecution") {
      call(evidence, item.id, "commandExecution", { command: item.command });
      result(evidence, item.id, item.aggregatedOutput, item.status === "completed" && item.exitCode === 0);
    }
  }
  return evidence;
}
export async function jsonLines(filename: string): Promise<Row[]> {
  return (await readFile(filename, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
function canonicalMatches(address: unknown, sessionId: string, harness: string): boolean {
  if (typeof address !== "string") return false;
  const parts = address.split(":");
  try { return parts.length === 4 && parts[0] === "nab" && !!parts[1] && decodeURIComponent(parts[2]) === harness && decodeURIComponent(parts[3]) === sessionId; } catch { return false; }
}
function participant(address: unknown, e: RuntimeEvidence, harness: string, aliases: string[]): boolean {
  if (typeof address !== "string") return false;
  const allowed = [...(e.aliases ?? []), ...aliases];
  const normalize = (value: string) => value.replace(/^uds:/, "");
  if (allowed.some((alias) => normalize(alias) === normalize(address))) return true;
  // A supplied canonical binding also pins the host, not only the native session UUID.
  return !allowed.some((alias) => alias.startsWith("nab:")) && canonicalMatches(address, e.sessionId, harness);
}
function contains(text: string, token: string): boolean {
  if (!token) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(text);
}
function messageText(c: EvidenceCall): string { return typeof c.arguments.text === "string" ? c.arguments.text : typeof c.arguments.message === "string" ? c.arguments.message : ""; }
const sendName = (harness: string) => harness === "claude" ? "SendMessage" : harness === "codex" ? "native_agent_broker.send_message" : harness === "pi" ? "send_message" : "";
function completed(e: RuntimeEvidence) {
  const events = e.events ?? [];
  const callCounts = new Map<string, number>();
  const results = new Map<string, Array<{ event: Extract<EvidenceEvent, { kind: "result" }>; index: number }>>();
  for (const [index, event] of events.entries()) {
    if (event.kind === "call") callCounts.set(event.id, (callCounts.get(event.id) ?? 0) + 1);
    if (event.kind === "result") results.set(event.callId, [...(results.get(event.callId) ?? []), { event, index }]);
  }
  return events.flatMap((event, index) => {
    if (event.kind !== "call" || callCounts.get(event.id) !== 1) return [];
    const matches = results.get(event.id) ?? [];
    if (matches.length !== 1) return [];
    const outcome = matches[0];
    return outcome.index > index && outcome.event.kind === "result" && outcome.event.success ? [{ call: event.call, index, end: outcome.index, result: outcome.event }] : [];
  });
}
function readCall(c: EvidenceCall, harness: string, challenge: string): boolean {
  if (harness === "claude" && c.name === "Read") return typeof c.arguments.file_path === "string";
  if (harness === "pi" && c.name === "read") return typeof c.arguments.path === "string";
  if (c.name !== (harness === "codex" ? "commandExecution" : harness === "claude" ? "Bash" : "bash")) return false;
  const command = c.arguments.command;
  // Shell output alone (echo/printf, failed commands, unrelated tools) is not file-read evidence.
  if (typeof command !== "string" || command.includes(challenge)) return false;
  const shell = command.match(/^\/(?:bin|usr\/bin)\/(?:ba)?sh -lc (['"])([^]*)\1$/);
  const readCommand = shell ? shell[2] : command;
  // Only a single recognizable read command; no pipelines, substitutions or extra commands.
  return /^(?:cat|sed|head|tail)\s+[^\n;|&`$<>]+$/.test(readCommand);
}
export function verifyRoundtrip(options: { sender: RuntimeEvidence; recipient: RuntimeEvidence; nonce: string; challenge: string; senderHarness: string; recipientHarness: string; senderAliases?: string[]; recipientAliases?: string[] }) {
  const { sender, recipient, nonce, challenge, senderHarness, recipientHarness } = options;
  const senderAliases = options.senderAliases ?? [], recipientAliases = options.recipientAliases ?? [];
  const checks = { senderToolCall: false, recipientInput: false, recipientReadChallenge: false, recipientReplyTool: false, senderReplyInput: false };
  const validSend = (c: ReturnType<typeof completed>[number], source: RuntimeEvidence, target: RuntimeEvidence, sourceHarness: string, targetHarness: string, sourceAliases: string[], targetAliases: string[]) => {
    const r = c.result.receipt;
    return c.call.name === sendName(sourceHarness) && participant(c.call.arguments.to, target, targetHarness, targetAliases) && !!r &&
      !["failed", "expired", "delivery_unknown"].includes(r.state) &&
      (sourceHarness === "claude" ? r.success === true && typeof r.msg_id === "string" : typeof r.messageId === "string" && participant(r.fromAgentId, source, sourceHarness, sourceAliases) && participant(r.toAgentId, target, targetHarness, targetAliases));
  };
  const sends = completed(sender), replies = completed(recipient);
  for (const request of sends) {
    const requestText = messageText(request.call);
    if (!contains(requestText, nonce) || contains(requestText, challenge) || !validSend(request, sender, recipient, senderHarness, recipientHarness, senderAliases, recipientAliases)) continue;
    checks.senderToolCall = true;
    for (const [start, event] of (recipient.events ?? []).entries()) {
      if (event.kind !== "input" || !event.peer || !participant(event.peer.from, sender, senderHarness, senderAliases) || event.peer.body.trim() !== requestText.trim()) continue;
      if (senderHarness !== "claude" && event.peer.messageId !== request.result.receipt!.messageId) continue;
      checks.recipientInput = true;
      const nextInput = recipient.events!.findIndex((v, i) => i > start && v.kind === "input");
      const end = nextInput < 0 ? recipient.events!.length : nextInput;
      const reads = replies.filter((c) => c.index > start && c.end < end && readCall(c.call, recipientHarness, challenge) && contains(c.result.text, challenge));
      if (!reads.length) continue;
      checks.recipientReadChallenge = true;
      for (const reply of replies) {
        const replyText = messageText(reply.call);
        if (!reads.some((read) => read.end < reply.index) || reply.end >= end || !contains(replyText, nonce) || !contains(replyText, challenge) || !validSend(reply, recipient, sender, recipientHarness, senderHarness, recipientAliases, senderAliases)) continue;
        if (reply.call.arguments.in_reply_to !== undefined && reply.call.arguments.in_reply_to !== event.peer.messageId) continue;
        checks.recipientReplyTool = true;
        for (const [index, returned] of (sender.events ?? []).entries()) {
          if (index <= request.end || returned.kind !== "input" || !returned.peer || !participant(returned.peer.from, recipient, recipientHarness, recipientAliases) || returned.peer.body.trim() !== replyText.trim()) continue;
          if (recipientHarness !== "claude" && returned.peer.messageId !== reply.result.receipt!.messageId) continue;
          // All checks must belong to this one chain, never a union of partial attempts.
          checks.senderReplyInput = true;
          return { pass: true, checks, senderSessionId: sender.sessionId, recipientSessionId: recipient.sessionId };
        }
      }
    }
  }
  return { pass: false, checks, senderSessionId: sender.sessionId, recipientSessionId: recipient.sessionId };
}
