import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket, type ClientOptions, type RawData } from "ws";

export const DEFAULT_CODEX_SOCKET_PATH = join(
  homedir(),
  ".codex/app-server-control/app-server-control.sock",
);
export const DEFAULT_CODEX_URL = `unix://${DEFAULT_CODEX_SOCKET_PATH}`;

export type RpcId = number | string;
export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}
export interface CodexConnectionOptions {
  url?: string;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxPayload?: number;
  onServerRequest?: (id: RpcId, method: string, params: unknown) => void;
}
export type ServerRequestResponse =
  | { result: unknown; error?: never }
  | { error: RpcErrorObject; result?: never };

export class RpcError extends Error {
  readonly name = "RpcError";

  constructor(
    message: string,
    readonly method: string,
    readonly uncertain = false,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type RpcMessage = {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcErrorObject;
};
type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: RpcError) => void;
  timer: NodeJS.Timeout;
};

const MAX_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PAYLOAD = 1024 * 1024;
const MAX_PAYLOAD_LIMIT = 16 * 1024 * 1024;
const MAX_PENDING_SERVER_REQUESTS = 1024;

export class CodexConnection extends EventEmitter {
  private readonly url: string;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly maxPayload: number;
  private readonly onServerRequest?: CodexConnectionOptions["onServerRequest"];
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private serverRequests = new Set<RpcId>();

  constructor(options: CodexConnectionOptions = {}) {
    super();
    this.url = options.url ?? DEFAULT_CODEX_URL;
    this.requestTimeoutMs = boundedTimeout(options.requestTimeoutMs);
    this.connectTimeoutMs = boundedTimeout(options.connectTimeoutMs);
    this.maxPayload = boundedPayload(options.maxPayload);
    this.onServerRequest = options.onServerRequest;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openAndInitialize().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const socket = this.openSocket(method);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.failure(method, `${method} timed out after send`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const pending = this.takePending(id);
        pending?.reject(this.failure(method, `${method} send failed`));
      });
    });
  }

  notify(method: string, params?: unknown): void {
    const socket = this.openSocket(method);
    socket.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  respond(id: RpcId, response: ServerRequestResponse): void {
    if (!this.serverRequests.delete(id)) {
      throw new RpcError("No pending server request with this id", "response");
    }
    const socket = this.openSocket("response");
    socket.send(JSON.stringify({ id, ...response }));
  }

  close(code = 1000, reason = "client closing"): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    this.rejectPending("connection closed by client");
    this.serverRequests.clear();
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason);
    }
  }

  private async openAndInitialize(): Promise<void> {
    const socket = this.createWebSocket();
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new RpcError("Codex connection timed out", "connect"));
      }, this.connectTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("open", onOpen);
        socket.off("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new RpcError("Codex connection failed", "connect"));
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
    });

    socket.on("message", (data, isBinary) => this.handleMessage(data, isBinary));
    socket.on("close", () => this.handleClose(socket));
    socket.on("error", () => undefined);

    try {
      await this.request("initialize", {
        clientInfo: { name: "native-agent-broker", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      this.notify("initialized");
    } catch (error) {
      socket.terminate();
      if (this.socket === socket) this.socket = null;
      throw error;
    }
  }

  private createWebSocket(): WebSocket {
    const options: ClientOptions = { maxPayload: this.maxPayload };
    if (this.url.startsWith("unix://")) {
      const socketPath = decodeURIComponent(this.url.slice("unix://".length));
      if (!socketPath) throw new RpcError("Unix socket path is empty", "connect");
      return new WebSocket(`ws+unix://${encodeURI(socketPath)}:/`, {
        ...options,
        headers: { Host: "localhost" },
        perMessageDeflate: false,
      });
    }
    if (!this.url.startsWith("ws://") && !this.url.startsWith("wss://")) {
      throw new RpcError("Codex URL must use unix://, ws://, or wss://", "connect");
    }
    return new WebSocket(this.url, options);
  }

  private handleMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.socket?.close(1003, "text frames required");
      return;
    }
    let message: RpcMessage;
    try {
      message = JSON.parse(data.toString()) as RpcMessage;
    } catch {
      this.socket?.close(1007, "invalid JSON");
      return;
    }
    if (!message || typeof message !== "object") {
      this.socket?.close(1007, "invalid JSON-RPC message");
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") {
      if (this.serverRequests.size >= MAX_PENDING_SERVER_REQUESTS) {
        const oldest = this.serverRequests.values().next().value as RpcId | undefined;
        if (oldest !== undefined) this.serverRequests.delete(oldest);
      }
      this.serverRequests.add(message.id);
      this.onServerRequest?.(message.id, message.method, message.params);
      this.emit("serverRequest", message.id, message.method, message.params);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.takePending(message.id);
      if (!pending) return;
      if (message.error) {
        pending.reject(
          new RpcError(
            message.error.message,
            pending.method,
            false,
            message.error.code,
            message.error.data,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      if (message.method === "serverRequest/resolved") {
        const requestId = (message.params as { requestId?: RpcId } | undefined)?.requestId;
        if (requestId !== undefined) this.serverRequests.delete(requestId);
      }
      this.emit("notification", message.method, message.params);
    }
  }

  private handleClose(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.rejectPending("connection closed after send");
    this.serverRequests.clear();
    this.emit("disconnected");
  }

  private rejectPending(detail: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(this.failure(pending.method, `${pending.method} ${detail}`));
      this.pending.delete(id);
    }
  }

  private takePending(id: RpcId): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    return pending;
  }

  private openSocket(method: string): WebSocket {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new RpcError("Codex connection is not open", method);
    }
    return this.socket;
  }

  private failure(method: string, message: string): RpcError {
    return new RpcError(message, method, method === "turn/start" || method === "turn/steer");
  }
}

function boundedTimeout(value = MAX_TIMEOUT_MS): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError("Timeout must be positive");
  return Math.min(value, MAX_TIMEOUT_MS);
}

function boundedPayload(value = DEFAULT_MAX_PAYLOAD): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PAYLOAD_LIMIT) {
    throw new RangeError(`maxPayload must be between 1 and ${MAX_PAYLOAD_LIMIT}`);
  }
  return value;
}
