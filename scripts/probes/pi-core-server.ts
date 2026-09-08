import { RegistryServer } from "../../src/registry/server.js";

const port = Number(process.env.NAB_PI_PROBE_PORT || 5499);
const dbPath = `${process.env.HOME}/.local/state/native-agent-broker/probes/pi/core.sqlite`;
const server = new RegistryServer(port, { native: true, dbPath, host: "127.0.0.1" });
await server.start();
const stop = async () => { await server.stop(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
