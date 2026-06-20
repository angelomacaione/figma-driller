/**
 * Field-pruned LAZY Kiwi decoder for `.fig` — lowers decode peak RSS by streaming `nodeChanges`
 * and skipping (advancing past, never allocating) the ~590 canvas/geometry fields the token
 * extractor never reads.
 *
 * Why: the reference decode `kiwi.compileSchema(schema).decodeMessage(data)` (in ingest-fig.js)
 * materializes the ENTIRE document graph. Measured on a large kit (54.6MB .fig, 87,237
 * nodeChanges): peak ~764MB RSS, enough to OOM a small (512MB) instance. The token system is a tiny
 * slice of that graph (VARIABLE_SET / VARIABLE / published-style nodes), so retaining only those —
 * and only their token-relevant fields — drops the peak by an order of magnitude while producing a
 * `{ nodeChanges }` message that is byte-identical (for `figMessageToResult`) to the full decode.
 * Validated deep-equal vs the reference decoder across a corpus of real specimens.
 *
 * Generic + schema-driven: reads the self-describing Kiwi schema (chunk 0) and walks the data
 * (chunk 1) with the same wire grammar the kiwi-schema lib generates — MESSAGE = a field-id loop
 * terminated by id 0; STRUCT = ordered fields, no terminator; ENUM = a varint; arrays = a varint
 * count then elements (except `byte[]` = a length-prefixed blob). It reuses kiwi's own `ByteBuffer`
 * primitive reads so every byte read is identical to the reference. On ANY shape surprise it throws
 * → the caller (figFileToPayload) falls back to the reference `decodeFig`. So this is a strictly
 * optional fast path: correct or it bails, never a silent divergence.
 */

import * as kiwi from "kiwi-schema";
import pako from "pako";
import * as fzstd from "fzstd";
import { unzipCanvas } from "./ingest-fig.js";

// ---- low-level chunk plumbing (mirrors ingest-fig.js decodeCanvas, kept local to avoid a cycle) --
function splitChunks(canvas) {
  let off = 12; // 8 magic ("fig-kiwi") + 4 version
  const chunks = [];
  while (off + 4 <= canvas.length) {
    const len = canvas.readUInt32LE(off); off += 4;
    if (len === 0 || off + len > canvas.length) break;
    chunks.push(canvas.slice(off, off + len)); off += len;
  }
  return chunks;
}
function decompressChunk(b) {
  for (const fn of [() => pako.inflateRaw(b), () => pako.inflate(b), () => Buffer.from(fzstd.decompress(b))]) {
    try { const r = fn(); if (r && r.length) return Buffer.from(r); } catch { /* try next codec */ }
  }
  throw new Error(".fig: could not decompress a chunk (tried deflate-raw, deflate, zstd)");
}

// ---- generic schema-driven Kiwi reader with allocation-free skip ----------------
const BASE = new Set(["bool", "byte", "int", "uint", "float", "string", "int64", "uint64"]);

function readBase(bb, t) {
  switch (t) {
    case "bool": return !!bb.readByte();
    case "byte": return bb.readByte();
    case "int": return bb.readVarInt();
    case "uint": return bb.readVarUint();
    case "float": return bb.readVarFloat();
    case "string": return bb.readString();
    case "int64": return bb.readVarInt64();
    case "uint64": return bb.readVarUint64();
  }
  throw new Error("lazy-fig: unknown base type " + t);
}

/** schema.definitions → { name: { kind, fields, byId, enumByVal } }. */
function buildDefs(schema) {
  const defs = {};
  for (const d of schema.definitions) {
    const e = { kind: d.kind, fields: d.fields, byId: {}, enumByVal: {} };
    for (const f of d.fields) { e.byId[f.value] = f; if (d.kind === "ENUM") e.enumByVal[f.value] = f.name; }
    defs[d.name] = e;
  }
  return defs;
}

/** Reader/skipper closed over a schema-definition index. read* build objects; skip* only advance. */
function makeReader(defs) {
  function readValue(bb, type) {
    if (BASE.has(type)) return readBase(bb, type);
    const def = defs[type];
    if (!def) throw new Error("lazy-fig: unknown type " + type);
    if (def.kind === "ENUM") return def.enumByVal[bb.readVarUint()];
    if (def.kind === "STRUCT") { const r = {}; for (const f of def.fields) r[f.name] = readField(bb, f); return r; }
    const r = {}; // MESSAGE
    while (true) {
      const id = bb.readVarUint();
      if (id === 0) return r;
      const f = def.byId[id];
      if (!f) throw new Error("lazy-fig: bad message field " + id + " in " + type);
      r[f.name] = readField(bb, f);
    }
  }
  function readField(bb, f) {
    if (f.isArray) {
      if (f.type === "byte") return bb.readByteArray();
      const n = bb.readVarUint(); const a = Array(n);
      for (let i = 0; i < n; i++) a[i] = readValue(bb, f.type);
      return a;
    }
    return readValue(bb, f.type);
  }
  function skipValue(bb, type) {
    if (BASE.has(type)) { readBase(bb, type); return; }
    const def = defs[type];
    if (!def) throw new Error("lazy-fig: unknown type " + type);
    if (def.kind === "ENUM") { bb.readVarUint(); return; }
    if (def.kind === "STRUCT") { for (const f of def.fields) skipField(bb, f); return; }
    while (true) { // MESSAGE
      const id = bb.readVarUint();
      if (id === 0) return;
      const f = def.byId[id];
      if (!f) throw new Error("lazy-fig: bad message field " + id + " in " + type);
      skipField(bb, f);
    }
  }
  function skipField(bb, f) {
    if (f.isArray) {
      if (f.type === "byte") { const n = bb.readVarUint(); bb._index += n; return; } // advance past blob, no copy
      const n = bb.readVarUint();
      for (let i = 0; i < n; i++) skipValue(bb, f.type);
      return;
    }
    skipValue(bb, f.type);
  }
  return { readField, skipField };
}

// The NodeChange fields `figMessageToResult` (ingest-fig.js) actually reads. Everything else on a
// node (the ~590 canvas/geometry/vector fields) is skipped. Keep in sync with the extractor.
export const KEEP_NODE_FIELDS = new Set([
  "guid", "type", "name", "key", "isSoftDeleted", "isPublishable", "styleType", "sourceLibraryKey",
  "variableSetModes", "variableSetID", "variableResolvedType", "variableDataValues", "variableScopes",
  "fillPaints", "fontName", "fontSize", "lineHeight", "letterSpacing", "opacity", "effects",
]);

/** Which nodes the extractor can use → the only ones worth retaining. */
function keepNode(n) {
  return n.type === "VARIABLE_SET" || n.type === "VARIABLE" || (n.styleType && n.isPublishable === true && !!n.name);
}

/**
 * Decoded Kiwi `schema` (from `kiwi.decodeBinarySchema`) + the decompressed data chunk → a
 * `{ nodeChanges }` message carrying only token-bearing nodes (token-relevant fields only).
 * Streams the top-level `nodeChanges` array, skipping every other Message field and every
 * non-token node, and on each kept node retaining only the KEEP_NODE_FIELDS. Exported so the
 * decode core is unit-testable against the reference decoder without a real binary `.fig`.
 */
export function decodeFilteredMessage(schema, dataBuf) {
  const defs = buildDefs(schema);
  const msgDef = defs["Message"], ncDef = defs["NodeChange"];
  if (!msgDef || !ncDef) throw new Error("lazy-fig: schema has no Message/NodeChange");
  if (!msgDef.fields.find((f) => f.name === "nodeChanges")) throw new Error("lazy-fig: Message has no nodeChanges field");

  const { readField, skipField } = makeReader(defs);
  const bb = new kiwi.ByteBuffer(dataBuf);
  const nodeChanges = [];
  while (true) {
    const id = bb.readVarUint();
    if (id === 0) break;
    const f = msgDef.byId[id];
    if (!f) throw new Error("lazy-fig: bad Message field " + id);
    if (f.name === "nodeChanges") {
      const n = bb.readVarUint();
      for (let i = 0; i < n; i++) {
        const node = {};
        while (true) {
          const fid = bb.readVarUint();
          if (fid === 0) break;
          const ff = ncDef.byId[fid];
          if (!ff) throw new Error("lazy-fig: bad NodeChange field " + fid);
          if (KEEP_NODE_FIELDS.has(ff.name)) node[ff.name] = readField(bb, ff);
          else skipField(bb, ff);
        }
        if (keepNode(node)) nodeChanges.push(node);
      }
    } else {
      skipField(bb, f);
    }
  }
  return { nodeChanges };
}

/**
 * `.fig` buffer → `{ nodeChanges }` carrying only token-bearing nodes (token-relevant fields only).
 * Throws on any decode/shape surprise so the caller can fall back to the reference full decode.
 */
export function decodeFigLazy(buf) {
  const canvas = unzipCanvas(buf);
  if (canvas.slice(0, 8).toString("latin1") !== "fig-kiwi") throw new Error("canvas.fig: missing fig-kiwi magic");
  const chunks = splitChunks(canvas);
  if (chunks.length < 2) throw new Error("canvas.fig: expected a schema chunk and a data chunk");
  const schema = kiwi.decodeBinarySchema(decompressChunk(chunks[0]));
  return decodeFilteredMessage(schema, decompressChunk(chunks[1]));
}
