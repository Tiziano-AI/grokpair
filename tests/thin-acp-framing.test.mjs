import assert from "node:assert/strict";
import test from "node:test";
import { ndJsonStream } from "@agentclientprotocol/sdk";

// These tests exercise the upstream framer rather than a duplicate parser.
// The consumer-path tests separately cover durable admission and worker loss.
const notification = { jsonrpc: "2.0", method: "session/update", params: { text: "λ🙂漢字\r\nExact text." } };
const outputSink = () => {
  const frames = [];
  return { frames, writable: new WritableStream({ write(bytes) { frames.push(Buffer.from(bytes)); } }) };
};

test("official ACP framing preserves split UTF-8 and accepts a complete final frame without a newline", async () => {
  const final = { jsonrpc: "2.0", id: "final", result: { text: "🙂λ" } };
  const bytes = Buffer.from(`${JSON.stringify(notification)}\n${JSON.stringify(final)}`);
  const input = new ReadableStream({ start(controller) {
    // Every multi-byte character crosses chunks, not just JSON field boundaries.
    for (let index = 0; index < bytes.length; index++) controller.enqueue(bytes.subarray(index, index + 1));
    controller.close();
  } });
  const output = outputSink();
  const stream = ndJsonStream(output.writable, input, { maxMessageBytes: Number.MAX_SAFE_INTEGER });
  const messages = [];
  for await (const message of stream.readable) messages.push(message);
  assert.deepEqual(messages, [notification, final]);
  assert.deepEqual(output.frames, [], "valid frames need no manufactured protocol response");
});

test("official ACP framing does not promote an unfinished trailing object into a notification", async () => {
  const input = new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from(`${JSON.stringify(notification)}\n{"jsonrpc":"2.0","method":"session/update","params":{"text":"UNFINISHED`));
    controller.close();
  } });
  const output = outputSink();
  const stream = ndJsonStream(output.writable, input, { maxMessageBytes: Number.MAX_SAFE_INTEGER });
  const messages = [];
  for await (const message of stream.readable) messages.push(message);
  assert.deepEqual(messages, [notification]);
  const response = JSON.parse(Buffer.concat(output.frames).toString("utf8"));
  assert.equal(response.id, null); assert.equal(response.error.code, -32700);
});

test("official ACP framing exposes transport failure after delivered text without inventing a terminal response", async () => {
  let source;
  const input = new ReadableStream({ start(controller) { source = controller; } });
  const output = outputSink();
  const stream = ndJsonStream(output.writable, input, { maxMessageBytes: Number.MAX_SAFE_INTEGER });
  const reader = stream.readable.getReader();
  source.enqueue(Buffer.from(`${JSON.stringify(notification)}\n`));
  assert.deepEqual(await reader.read(), { value: notification, done: false });
  const failure = new Error("Deterministic native pipe failure");
  source.error(failure);
  await assert.rejects(reader.read(), error => error === failure);
  assert.deepEqual(output.frames, [], "pipe failure is not a native completion or replay instruction");
  reader.releaseLock();
});
