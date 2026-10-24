import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SSE_DONE, encodeSSE, iterateSSEData, parseSSEData } from "../src/core/sse.js";

async function collect(chunks: string[]): Promise<string[]> {
  const stream = (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
  const out: string[] = [];
  for await (const data of iterateSSEData(stream)) out.push(data);
  return out;
}

describe("encodeSSE", () => {
  it("formats an OpenAI data frame", () => {
    assert.equal(encodeSSE({ a: 1 }), 'data: {"a":1}\n\n');
    assert.equal(SSE_DONE, "data: [DONE]\n\n");
  });
});

describe("iterateSSEData", () => {
  it("handles frames split across chunks", async () => {
    const frames = await collect(['data: {"a"', ':1}\n\ndata: {"b":2}\n\n']);
    assert.deepEqual(frames, ['{"a":1}', '{"b":2}']);
  });

  it("decodes multi-byte characters split across chunks", async () => {
    const payload = Buffer.from('data: {"t":"héllo 世界"}\n\n');
    const chunkA = new Uint8Array(payload.subarray(0, 12));
    const chunkB = new Uint8Array(payload.subarray(12));
    const stream = (async function* () {
      yield chunkA;
      yield chunkB;
    })();

    const frames: string[] = [];
    for await (const data of iterateSSEData(stream)) frames.push(data);
    assert.equal(frames.length, 1);
    assert.equal(JSON.parse(frames[0]!).t, "héllo 世界");
  });

  it("ignores comments, blank lines and handles a missing trailing newline", async () => {
    const frames = await collect([": keep-alive\n\n", "\n", "data: [DONE]"]);
    assert.deepEqual(frames, ["[DONE]"]);
  });
});

describe("parseSSEData", () => {
  it("parses JSON and ignores the terminator", () => {
    assert.deepEqual(parseSSEData('{"x":true}'), { x: true });
    assert.equal(parseSSEData("[DONE]"), undefined);
    assert.equal(parseSSEData("not json"), undefined);
  });
});
