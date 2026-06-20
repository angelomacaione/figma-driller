import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { decodeFilteredMessage, decodeFigLazy, KEEP_NODE_FIELDS } from "../src/api/fig-lazy-decode.js";
import { figFileToDtcg, figMessageToResult, decodeFig } from "../src/api/ingest-fig.js";
import { buildSynthetic, G } from "./_fig-synth.js";

// ---------------------------------------------------------------------------------------------

test("lazy decoder core == reference Kiwi decode (filtered) — read/skip/enum/struct/array/byte[]", () => {
  const { schema, compiled, data, msg } = buildSynthetic();
  const keep = (n) => n.type === "VARIABLE_SET" || n.type === "VARIABLE" || (n.styleType && n.isPublishable === true && !!n.name);
  const pick = (n) => { const o = {}; for (const k of Object.keys(n)) if (KEEP_NODE_FIELDS.has(k)) o[k] = n[k]; return o; };
  const expected = compiled.decodeMessage(data).nodeChanges.filter(keep).map(pick);
  const got = decodeFilteredMessage(schema, data).nodeChanges;
  assert.deepEqual(got, expected);
  assert.equal(got.length, 2, "VARIABLE_SET + VARIABLE kept, FRAME pruned");
});

test("synthetic .fig → figFileToDtcg (lazy) yields the token, with the skip-fields gone", () => {
  const { canvas } = buildSynthetic();
  const r = figFileToDtcg(canvas, { fileName: "synth" });
  assert.equal(r.declined, false);
  assert.equal(r.stats.tokensEmitted, 1);
  assert.equal(r.payload.tokens.C.brand.blue.$type, "color");
  assert.equal(r.payload.tokens.C.brand.blue.$value, "#0000FF");
});

test("lazy and reference decode produce identical results on a real .fig shape", () => {
  const { canvas } = buildSynthetic();
  const lazy = figFileToDtcg(canvas, { fileName: "synth" });                       // default = lazy
  const ref = figFileToDtcg(canvas, { fileName: "synth", referenceDecode: true }); // forced full decode
  assert.deepEqual(lazy, ref);
});

test("pruning is real: a fat canvas node does not bloat the kept set", () => {
  // 50 extra pure-canvas FRAME nodes with big byte arrays → still only the 1 VARIABLE survives.
  const fat = Array.from({ length: 50 }, (_, i) => ({ type: "FRAME", guid: G(9, i), name: "F" + i, vectorData: new Uint8Array(8192), junk: [i, i, i] }));
  const { canvas } = buildSynthetic(fat);
  const r = figFileToDtcg(canvas, { fileName: "synth" });
  assert.equal(r.stats.tokensEmitted, 1);
});

// ---- gated parity over the real corpus specimens (uncommitted; set AMACA_FIG_DIR to run) -------
const FIG_DIR = process.env.AMACA_FIG_DIR;
const haveSpecimens = (() => { try { return !!FIG_DIR && fs.readdirSync(FIG_DIR).some((f) => f.endsWith(".fig")); } catch { return false; } })();

test("lazy ≡ reference on every real specimen (deep-equal figMessageToResult)", { skip: !haveSpecimens }, () => {
  for (const f of fs.readdirSync(FIG_DIR).filter((x) => x.endsWith(".fig"))) {
    const buf = fs.readFileSync(path.join(FIG_DIR, f));
    const ref = figMessageToResult(decodeFig(buf), { fileName: f });
    const lazy = figMessageToResult(decodeFigLazy(buf), { fileName: f });
    assert.deepEqual(lazy, ref, `${f}: lazy decode must match the reference decode exactly`);
  }
});
