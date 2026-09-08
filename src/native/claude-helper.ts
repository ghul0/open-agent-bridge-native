import { createProjection, sendFrame, type WireFrame } from "./claude-wire.js";

const [name, sessionId, socketDirectory] = process.argv.slice(2);
if (!name || !sessionId || !socketDirectory || !process.send) throw new Error("Projection requires a managed IPC parent");
const projection = await createProjection({ name, sessionId, socketDirectory,
  onFrame: (frame) => process.send?.({ type: "frame", frame }) });
process.send({ type: "ready", socketPath: projection.socketPath, pid: process.pid });
process.on("message", async (request: { id: string; address: string; frame: WireFrame }) => {
  try { await sendFrame(request.address, request.frame); process.send?.({ type: "written", id: request.id }); }
  catch (error) { process.send?.({ type: "write_error", id: request.id, beforeWrite: Boolean((error as { beforeWrite?: boolean }).beforeWrite), error: error instanceof Error ? error.message : "Native write failed" }); }
});
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await projection.close(); process.exit(0); }
process.on("disconnect", stop);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
