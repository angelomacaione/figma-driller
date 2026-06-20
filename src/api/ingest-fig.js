/**
 * Figma `.fig` DIRECT import → canonical payload (acquisition-only, owned pipeline).
 *
 * Upload a `.fig` (no plugin) → this module decodes Figma's Kiwi binary and extracts the
 * design-token system (Variables + Styles), then builds the SAME canonical payload the Figma
 * plugin would POST, and hands it to `figmaPayloadToDtcg` (src/api/ingest-figma.js), so a
 * plugin export and a direct `.fig` upload converge on one downstream transform.
 *
 * Design notes:
 *   - alias core .......... 3-class resolution: in-file GUID, assetRef-by-publish-key (library
 *                           snapshots ARE embedded → resolve, not "external"), truly-external fallback;
 *                           cycle-safe chain resolution. (library-gap ≈ 0 on real files)
 *   - typing .............. `variableScopes`-first (FLOAT→dimension, FONT_FAMILY→fontFamily, …),
 *                           name/value fallback when scopes absent; never silently mis-type.
 *   - styles + arbitration. named/published styles only; var↔style overlap surfaced as incoherences.
 *   - robustness .......... soft-deleted nodes excluded; decode/extract guarded; empty → declined.
 *
 * `.fig` layout (measured): a ZIP holding `canvas.fig` (magic "fig-kiwi": [magic 8][version u32]
 * [len u32][schema chunk][len u32][data chunk], each DEFLATE or ZSTD; chunk0 = self-describing
 * Kiwi schema, chunk1 = the message). Decode via kiwi-schema; the message's `nodeChanges` carry
 * VARIABLE_SET (collections+modes), VARIABLE (tokens), and styleType-bearing nodes (styles).
 */

import zlib from "node:zlib";
import * as kiwi from "kiwi-schema";
import pako from "pako";
import * as fzstd from "fzstd";
import { figmaPayloadToDtcg } from "./ingest-figma.js";
import { decodeFigLazy } from "./fig-lazy-decode.js";

// ---- low-level decode -------------------------------------------------------

/** GUID → comparable "sessionID:localID" key. Accepts a raw guid or a {guid} wrapper. */
function gk(g) { const x = g && g.guid ? g.guid : g; return x ? `${x.sessionID}:${x.localID}` : "?"; }

/** Pull `canvas.fig` out of a `.fig` ZIP (central-directory scan; handles streamed entries).
 *  If the buffer is already a raw `fig-kiwi` file, return it unchanged. */
export function unzipCanvas(buf) {
  if (buf.slice(0, 8).toString("latin1") === "fig-kiwi") return buf;
  if (buf.slice(0, 2).toString("latin1") !== "PK") throw new Error("not a .fig (neither ZIP nor fig-kiwi)");
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error(".fig zip: end-of-central-directory not found");
  let cd = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error(".fig zip: bad central-directory header");
    const method = buf.readUInt16LE(cd + 10);
    const compSize = buf.readUInt32LE(cd + 20);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const lhOff = buf.readUInt32LE(cd + 42);
    const fname = buf.slice(cd + 46, cd + 46 + nameLen).toString("utf8");
    if (fname === "canvas.fig") {
      const lhNameLen = buf.readUInt16LE(lhOff + 26);
      const lhExtraLen = buf.readUInt16LE(lhOff + 28);
      const dataStart = lhOff + 30 + lhNameLen + lhExtraLen;
      const comp = buf.slice(dataStart, dataStart + compSize);
      return method === 0 ? comp : zlib.inflateRawSync(comp);
    }
    cd += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(".fig zip: canvas.fig entry not found");
}

function decompressChunk(b) {
  for (const fn of [() => pako.inflateRaw(b), () => pako.inflate(b), () => Buffer.from(fzstd.decompress(b))]) {
    try { const r = fn(); if (r && r.length) return Buffer.from(r); } catch { /* try next codec */ }
  }
  throw new Error(".fig: could not decompress a chunk (tried deflate-raw, deflate, zstd)");
}

/** canvas.fig (kiwi) → decoded message `{ type, nodeChanges[], blobs[], … }`. */
export function decodeCanvas(canvas) {
  if (canvas.slice(0, 8).toString("latin1") !== "fig-kiwi") throw new Error("canvas.fig: missing fig-kiwi magic");
  let off = 12; // 8 magic + 4 version
  const chunks = [];
  while (off + 4 <= canvas.length) {
    const len = canvas.readUInt32LE(off); off += 4;
    if (len === 0 || off + len > canvas.length) break;
    chunks.push(canvas.slice(off, off + len)); off += len;
  }
  if (chunks.length < 2) throw new Error("canvas.fig: expected a schema chunk and a data chunk");
  const schema = kiwi.decodeBinarySchema(decompressChunk(chunks[0]));
  return kiwi.compileSchema(schema).decodeMessage(decompressChunk(chunks[1]));
}

/** `.fig` buffer → decoded Kiwi message. */
export function decodeFig(buf) { return decodeCanvas(unzipCanvas(buf)); }

// ---- value / type helpers ---------------------------------------------------

const clamp255 = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));

/** Figma color {r,g,b,a} 0..1 → `#RRGGBB` (alpha 1) else `rgba(r,g,b,a)`. */
export function encodeColor(c) {
  if (!c) return null;
  const r = clamp255(c.r ?? 0), g = clamp255(c.g ?? 0), b = clamp255(c.b ?? 0);
  const a = c.a == null ? 1 : c.a;
  if (a >= 1) return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;
}

/** A non-alias per-mode value → its literal. */
function encodeLiteral(val) {
  if (!val || typeof val !== "object") return val ?? null;
  if ("colorValue" in val) return encodeColor(val.colorValue);
  if ("floatValue" in val) return val.floatValue;
  if ("textValue" in val) return val.textValue;
  if ("boolValue" in val) return val.boolValue;
  return null;
}

const DIMENSION_SCOPES = new Set([
  "CORNER_RADIUS", "GAP", "WIDTH_HEIGHT", "STROKE_FLOAT", "EFFECT_FLOAT",
  "PARAGRAPH_SPACING", "PARAGRAPH_INDENT", "FONT_SIZE", "LINE_HEIGHT", "LETTER_SPACING",
]);

/** Resolved DTCG-ish type from Figma resolvedType + variableScopes (scopes-first, then fallback). */
export function inferType(resolvedType, scopes = [], name = "") {
  const sc = new Set(scopes || []);
  if (resolvedType === "COLOR") return "color";
  if (resolvedType === "BOOLEAN") return "boolean";
  if (resolvedType === "STRING") {
    if (sc.has("FONT_FAMILY")) return "fontFamily";
    return "string";
  }
  if (resolvedType === "FLOAT") {
    if (sc.has("OPACITY")) return "number";
    if ([...sc].some((s) => DIMENSION_SCOPES.has(s))) return "dimension";
    // fallback heuristic when scopes are absent (e.g. flat color-only files have none on FLOATs)
    if (/radius|space|spacing|gap|size|width|height|padding|margin|stroke/i.test(name)) return "dimension";
    return "number";
  }
  return "other";
}

// ---- extraction (pure: message → result) ------------------------------------

function emptyStats() {
  return { variables: 0, tokensEmitted: 0, aliasesResolved: 0, aliasesExternal: 0, styles: 0, modes: 0, incoherenceSummary: { total: 0, byKind: {}, bySeverity: {} } };
}

/**
 * Pure core: decoded Kiwi message → { declined, collections, tokens(payload), styles, incoherences, stats }.
 * `tokens` is the nested object `figmaPayloadToDtcg` consumes (namespaced by collection name to avoid
 * cross-collection path collisions). Exported for unit testing without a binary.
 */
export function figMessageToResult(message, opts = {}) {
  const ncs = (message && message.nodeChanges) || [];
  const sets = ncs.filter((n) => n.type === "VARIABLE_SET" && !n.isSoftDeleted);
  const vars = ncs.filter((n) => n.type === "VARIABLE" && !n.isSoftDeleted);
  const styleNodes = ncs.filter((n) => n.styleType && n.isPublishable === true && n.name && !n.isSoftDeleted);

  if (vars.length === 0 && styleNodes.length === 0) {
    return {
      declined: true,
      reason: "This Figma file has no Variables or published Styles to import (pure canvas).",
      collections: [], tokens: {}, styles: [], incoherences: [], stats: emptyStats(),
    };
  }

  const setById = {}; for (const s of sets) setById[gk(s.guid)] = s;
  const byGuid = {}, byKey = {};
  for (const v of vars) { byGuid[gk(v.guid)] = v; if (v.key) byKey[v.key] = v; }

  // per-collection modeId↔name maps
  const modeIdToName = {}, modeNameToId = {};
  for (const s of sets) {
    const sid = gk(s.guid); const a = {}, b = {};
    for (const md of s.variableSetModes || []) { a[gk(md.id)] = md.name; b[md.name] = gk(md.id); }
    modeIdToName[sid] = a; modeNameToId[sid] = b;
  }
  const setName = (setRef) => setById[gk(setRef)]?.name || null;
  const defaultModeName = (setRef) => (setById[gk(setRef)]?.variableSetModes?.[0]?.name) || null;

  const stats = emptyStats();
  stats.variables = vars.length;

  /** Resolve one variable's value in a given mode name → { value, aliasRef?, partial? }. Cycle-safe. */
  function valueForMode(v, modeName, seen) {
    const sid = gk(v.variableSetID);
    const entries = v.variableDataValues?.entries || [];
    const wantId = modeNameToId[sid]?.[modeName];
    let entry = wantId ? entries.find((e) => gk(e.modeID) === wantId) : null;
    if (!entry) entry = entries[0];
    if (!entry) return { value: null };
    const val = entry.variableData?.value;
    const alias = val && (val.alias || val.variableAlias);
    if (!alias) return { value: encodeLiteral(val) };

    // alias: in-file GUID, or assetRef resolved by publish key (embedded library snapshot)
    const tgt = alias.guid ? byGuid[gk(alias.guid)] : (alias.assetRef ? byKey[alias.assetRef.key] : null);
    if (!tgt) {
      stats.aliasesExternal++;
      return { value: null, aliasRef: `library:${alias.assetRef?.key || "unknown"}`, partial: true };
    }
    const tgtKey = gk(tgt.guid);
    if (seen.has(tgtKey)) return { value: null, aliasRef: "cycle", partial: true };
    seen.add(tgtKey);
    stats.aliasesResolved++;
    const r = valueForMode(tgt, modeName, seen);
    return { value: r.value, aliasRef: `${setName(tgt.variableSetID)}::${tgt.name}`, partial: !!r.partial };
  }

  // build the payload token tree, namespaced by collection name
  const tokens = {};
  const collectionsUsed = new Map(); // name -> defaultMode
  const seenPath = new Map(); // "coll/path" -> {library} for dup detection
  const incoherences = [];

  for (const v of vars) {
    const sid = gk(v.variableSetID);
    const coll = setName(v.variableSetID) || "(unknown)";
    const isLib = !!setById[sid]?.sourceLibraryKey;
    const path = String(v.name || "").split("/").map((s) => s.trim()).filter(Boolean);
    if (!path.length) continue;
    const modes = setById[sid]?.variableSetModes || [];
    const type = inferType(v.variableResolvedType, v.variableScopes, v.name);

    const modeMap = {};
    for (const md of modes) {
      const r = valueForMode(v, md.name, new Set([gk(v.guid)]));
      modeMap[md.name] = r.aliasRef && r.aliasRef !== "cycle" ? { value: r.value, aliasRef: r.aliasRef } : { value: r.value };
      if (r.partial) modeMap[md.name].partial = true;
    }
    const defMode = defaultModeName(v.variableSetID);
    const base = (defMode && defMode in modeMap) ? modeMap[defMode].value : (Object.values(modeMap)[0]?.value ?? null);

    // dup variable across local+library copies of a same-named collection → local wins, flag it
    const dupKey = `${coll}/${path.join("/")}`;
    if (seenPath.has(dupKey)) {
      if (isLib) continue; // a library snapshot duplicate of an already-emitted token: skip
      incoherences.push({ kind: "dup-variable", key: dupKey });
    }
    seenPath.set(dupKey, { library: isLib });

    // nest under collection name → path
    let node = tokens[coll] || (tokens[coll] = {});
    for (let i = 0; i < path.length - 1; i++) node = node[path[i]] || (node[path[i]] = {});
    node[path[path.length - 1]] = {
      $type: type,
      $value: base,
      $extensions: { amaca: { collection: coll, modes: modeMap, ...(v.variableScopes?.length ? { scopes: v.variableScopes } : {}) } },
    };
    stats.tokensEmitted++;
    if (!collectionsUsed.has(coll)) collectionsUsed.set(coll, defMode || (modes[0]?.name) || null);
  }

  // ---- styles (named/published only) ----
  const styles = [];
  const colorIndexByValue = new Map(); // hex/rgba -> [token names] (for var↔style dedup/incoherence)
  for (const coll of Object.keys(tokens)) indexColors(tokens[coll], [coll], colorIndexByValue);

  for (const n of styleNodes) {
    const kind = String(n.styleType).toLowerCase();
    if (kind === "fill") {
      const paint = (n.fillPaints || []).find((p) => p.visible !== false);
      const value = paint?.type === "SOLID" ? encodeColor({ ...paint.color, a: paint.opacity ?? paint.color?.a }) : null;
      styles.push({ kind, name: n.name, value });
      if (value && colorIndexByValue.has(value)) {
        incoherences.push({ kind: "var-vs-style", value, style: n.name, variables: colorIndexByValue.get(value).slice() });
      }
    } else if (kind === "text") {
      styles.push({
        kind, name: n.name,
        value: {
          fontFamily: n.fontName?.family ?? null, fontStyle: n.fontName?.style ?? null,
          fontSize: n.fontSize ?? null, lineHeight: n.lineHeight ?? null, letterSpacing: n.letterSpacing ?? null,
          color: ((n.fillPaints || [])[0]?.type === "SOLID") ? encodeColor(n.fillPaints[0].color) : null,
        },
      });
    } else if (kind === "effect") {
      styles.push({ kind, name: n.name, value: { effects: Array.isArray(n.effects) ? n.effects.length : 0 } });
    } else {
      styles.push({ kind, name: n.name, value: {} });
    }
  }
  stats.styles = styles.length;

  const collections = [...collectionsUsed.entries()].map(([name, defaultMode]) => ({
    name, defaultMode, library: !!sets.find((s) => s.name === name && s.sourceLibraryKey),
    modes: (sets.find((s) => s.name === name)?.variableSetModes || []).map((m) => m.name),
  }));
  stats.modes = collections.reduce((acc, c) => acc + (c.modes?.length || 0), 0);

  const ranked = summarizeIncoherences(incoherences);
  stats.incoherenceSummary = ranked.summary;
  return { declined: false, reason: null, collections, tokens, styles, incoherences: ranked.items, stats };
}

// ---- incoherence ranking + dedup --------------------------------------------
// Raw extraction emits ONE entry per overlapping style, so a variable-driven DS floods the list
// (measured: CDS 182, M3 456). Collapse to one entry per (kind, value/key), tag a severity, and sort.
// Severity model: a published style MIRRORING a variable colour is expected redundancy → `info` (the
// dominant noise source); a token defined in two collection copies is ambiguous source → `warn`.
// Pure + deterministic; exported for unit testing.
const SEVERITY = { error: 0, warn: 1, info: 2 };

export function summarizeIncoherences(raw = []) {
  const styleByValue = new Map(); // hex/rgba -> { styles:Set, variables:Set }
  const dupByKey = new Map();     // "coll/path" -> occurrence count
  for (const it of raw) {
    if (!it) continue;
    if (it.kind === "var-vs-style") {
      const g = styleByValue.get(it.value) || { styles: new Set(), variables: new Set() };
      if (it.style) g.styles.add(it.style);
      for (const v of it.variables || []) g.variables.add(v);
      styleByValue.set(it.value, g);
    } else if (it.kind === "dup-variable") {
      dupByKey.set(it.key, (dupByKey.get(it.key) || 0) + 1);
    }
  }
  const items = [];
  for (const [value, g] of styleByValue) {
    const styles = [...g.styles], variables = [...g.variables];
    items.push({
      kind: "var-vs-style", severity: "info", value, count: styles.length,
      styles: styles.slice(0, 8), variables: variables.slice(0, 8),
      detail: `${styles.length} published style${styles.length === 1 ? "" : "s"} duplicate${styles.length === 1 ? "s" : ""} variable value ${value}${variables.length ? ` (${variables[0]})` : ""}`,
    });
  }
  for (const [key, count] of dupByKey) {
    items.push({ kind: "dup-variable", severity: "warn", key, count, detail: `"${key}" exists in multiple collection copies (kept local)` });
  }
  // most-severe first (error→warn→info), then by count desc within a severity
  items.sort((a, b) => (SEVERITY[a.severity] - SEVERITY[b.severity]) || (b.count - a.count));
  const byKind = {}, bySeverity = {};
  for (const it of items) { byKind[it.kind] = (byKind[it.kind] || 0) + 1; bySeverity[it.severity] = (bySeverity[it.severity] || 0) + 1; }
  return { items, summary: { total: items.length, byKind, bySeverity } };
}

/** Walk a token subtree collecting color leaf values → index for var↔style overlap. */
function indexColors(node, trail, out) {
  if (!node || typeof node !== "object") return;
  if (node.$type === "color" && node.$value) {
    const arr = out.get(node.$value) || []; arr.push(trail.join("/")); out.set(node.$value, arr);
    return;
  }
  for (const k of Object.keys(node)) if (!k.startsWith("$")) indexColors(node[k], [...trail, k], out);
}

// ---- public surface ---------------------------------------------------------

/**
 * Decode a `.fig` to the Kiwi message the extractor consumes. Default = the field-pruned LAZY
 * decoder (src/api/fig-lazy-decode.js): it streams nodeChanges and skips canvas geometry, cutting
 * the peak RSS ~3x (a ~55MB specimen: 764MB → 251MB) so large kits decode within a small memory budget.
 * On ANY decode/shape surprise (e.g. a future Kiwi-schema bump) it falls back to the reference full
 * decode — strictly optional fast path, never a silent divergence. `opts.referenceDecode` forces
 * the reference path (tests / debugging).
 */
export function figDecode(buf, opts = {}) {
  if (opts.referenceDecode) return decodeFig(buf);
  try { return decodeFigLazy(buf); }
  catch { return decodeFig(buf); }
}

/** `.fig` buffer → the canonical plugin-shaped payload (+ extraction extras). */
export function figFileToPayload(buf, opts = {}) {
  const message = figDecode(buf, opts);
  const res = figMessageToResult(message, opts);
  if (res.declined) return res;
  return {
    meta: { source: "figma-plugin", fileName: opts.fileName || "figma", origin: "fig-file" },
    collections: res.collections.map(({ name, defaultMode }) => ({ name, defaultMode })),
    tokens: res.tokens,
    styles: res.styles,
    incoherences: res.incoherences,
    stats: res.stats,
  };
}

/**
 * `.fig` buffer → { declined?, dtcg, payload, styles, incoherences, stats }.
 * Reuses the `figmaPayloadToDtcg` transform so the downstream DTCG output is identical to a plugin export.
 */
export function figFileToDtcg(buf, opts = {}) {
  const payload = figFileToPayload(buf, opts);
  if (payload.declined) return payload;
  const dtcg = figmaPayloadToDtcg(payload);
  return { declined: false, dtcg, payload, styles: payload.styles, incoherences: payload.incoherences, stats: payload.stats };
}

/** A corpus/session-friendly slug from a file name. */
export function figName(fileName) {
  return String(fileName || "figma").toLowerCase().replace(/\.fig$/i, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "figma";
}
