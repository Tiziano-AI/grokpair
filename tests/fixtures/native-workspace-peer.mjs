#!/usr/bin/env node
// Transport and utility stand-in; live native copy-policy qualification is separate.
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const env = process.env;
appendFileSync(env.NATIVE_WORKSPACE_TRACE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), marker: env.GROKPAIR_COLLABORATOR, sandbox_environment: env.GROK_SANDBOX }) + "\n");
if (env.NATIVE_WORKSPACE_STDERR) process.stderr.write(env.NATIVE_WORKSPACE_STDERR);
if (env.NATIVE_WORKSPACE_LARGE_STDERR) await new Promise(resolve => process.stderr.write("native denial\n" + "x".repeat(100_000), resolve));
if (process.argv.includes("worktree")) {
  if (env.NATIVE_WORKSPACE_RETURN) process.stdout.write(env.NATIVE_WORKSPACE_RETURN + "\n");
  if (env.NATIVE_WORKSPACE_HOLD) await new Promise(() => { setInterval(() => {}, 1000); });
  process.exit(Number(env.NATIVE_WORKSPACE_EXIT ?? 0));
}
if (env.NATIVE_WORKSPACE_EXIT) process.exit(Number(env.NATIVE_WORKSPACE_EXIT));
const app = agent();
app.onRequest("initialize", value => value, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }));
app.onRequest("session/new", value => value, ({ params }) => ({ sessionId: params._meta.sessionId }));
app.onRequest("session/close", value => value, () => ({}));
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin), { maxMessageBytes: Number.MAX_SAFE_INTEGER }));
await connection.closed;
