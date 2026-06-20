import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { figFileToDtcgIsolated } from "../src/api/fig-worker.js";
import { figFileToDtcg } from "../src/api/ingest-fig.js";
import { buildSynthetic } from "./_fig-synth.js";

test("isolated decode: a synthetic .fig matches the in-process decode (off-main-thread, same result)", async () => {
  const { canvas } = buildSynthetic();
  const inProcess = figFileToDtcg(canvas, { fileName: "synth" });
  const isolated = await figFileToDtcgIsolated(canvas, { fileName: "synth" });
  assert.equal(isolated.declined, false);
  assert.equal(isolated.stats.tokensEmitted, inProcess.stats.tokensEmitted);
  assert.deepEqual(isolated.dtcg, inProcess.dtcg);
});

test("isolated decode: garbage bytes → clean error result, main thread survives", async () => {
  const r = await figFileToDtcgIsolated(Buffer.from("definitely not a .fig file"), { fileName: "x" });
  assert.ok(r.error, "non-fig bytes yield an error result, not a crash");
  assert.ok(!r.dtcg);
});

test("isolated decode: an empty/pure-canvas-equivalent declines, not errors", async () => {
  // A valid fig-kiwi with only a FRAME node → figMessageToResult declines (no tokens/styles).
  const { schema, compiled } = buildSynthetic();
  const data = Buffer.from(compiled.encodeMessage({ type: "FRAME", signalName: "x", nodeChanges: [
    { type: "FRAME", guid: { sessionID: 1, localID: 1 }, name: "only canvas", vectorData: new Uint8Array(16), junk: [1] },
  ] }));
  // re-wrap as a raw fig-kiwi canvas
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const kiwi = req("kiwi-schema"); const pako = req("pako");
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
  const sB = Buffer.from(pako.deflateRaw(kiwi.encodeBinarySchema(schema)));
  const dB = Buffer.from(pako.deflateRaw(data));
  const chunk = (b) => Buffer.concat([u32(b.length), b]);
  const canvas = Buffer.concat([Buffer.from("fig-kiwi"), u32(106), chunk(sB), chunk(dB)]);
  const r = await figFileToDtcgIsolated(canvas, { fileName: "canvasonly" });
  assert.equal(r.declined, true);
});

test("isolated decode: a tiny timeout aborts to overLimit (never crashes the caller)", async () => {
  const { canvas } = buildSynthetic();
  const r = await figFileToDtcgIsolated(canvas, { fileName: "synth" }, { timeoutMs: 1 });
  // Either the (fast) decode beat the 1ms timer → a normal result, or it tripped → overLimit.
  // The contract under test: the call always RESOLVES (no throw/crash), with a well-formed outcome.
  assert.ok(r.overLimit === true || r.declined === false, "resolves to a defined outcome, never rejects");
});

// ---- gated over the real corpus (uncommitted; set AMACA_FIG_DIR to run) ----
const FIG_DIR = process.env.AMACA_FIG_DIR;
const m3 = (() => { try { return FIG_DIR && fs.readdirSync(FIG_DIR).find((f) => /material 3/i.test(f) && f.endsWith(".fig")); } catch { return null; } })();

test("isolated decode: Material-3 ingests via the worker (real specimen)", { skip: !m3 }, async () => {
  const r = await figFileToDtcgIsolated(fs.readFileSync(path.join(FIG_DIR, m3)), { fileName: m3 });
  assert.equal(r.declined, false);
  assert.ok(r.stats.tokensEmitted > 0);
});

test("isolated decode: a 1ms timeout on the big specimen → overLimit, instance survives", { skip: !m3 }, async () => {
  const r = await figFileToDtcgIsolated(fs.readFileSync(path.join(FIG_DIR, m3)), { fileName: m3 }, { timeoutMs: 1 });
  assert.equal(r.overLimit, true);
});
