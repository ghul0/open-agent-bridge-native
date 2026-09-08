#!/usr/bin/env node
import { runE2E } from "../src/native/e2e.js";

const args = process.argv.slice(2);
const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const brokerUrl = value("--broker-url");
if (!brokerUrl) throw new Error("Usage: e2e-local-3.ts --broker-url <url> [--project <path>] [--launcher <path>] [--run-id <id>]");
const result = await runE2E({ suite: "local-3", tmux: true, brokerUrl, project: value("--project"), launcher: value("--launcher"), runId: value("--run-id") });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.status === "PASS" ? 0 : result.status === "BLOCKED_ENVIRONMENT" || result.status === "NOT_RUN" ? 2 : 1;
