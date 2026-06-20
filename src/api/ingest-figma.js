/**
 * Canonical token payload → DTCG (pure transform, acquisition-only).
 *
 * The input is a canonical payload: DTCG-nested `tokens`, each leaf carrying
 * `$extensions.amaca.modes = { <modeName>: { value, aliasRef? } }`. This PURE transform
 * flattens it to a plain DTCG tokens object:
 *   - `$value` = the value at the collection's default mode (scalar),
 *   - `$extensions.modes` = a scalar mode→value map a downstream normalizer can lift to
 *     first-class `$modes`.
 *
 * Shapes the source only — no network, no I/O.
 */

/** payload → DTCG tokens object (nested, scalar $value + scalar $extensions.modes). */
export function figmaPayloadToDtcg(payload) {
  if (!payload || typeof payload !== "object") throw new Error("empty payload");
  const tokens = payload.tokens || {};
  const defaultMode = {};
  for (const c of payload.collections || []) if (c && c.name) defaultMode[c.name] = c.defaultMode;

  function leaf(node) {
    const amaca = node.$extensions && node.$extensions.amaca;
    const modes = amaca && amaca.modes && typeof amaca.modes === "object" ? amaca.modes : null;
    if (!modes) return { $type: node.$type, $value: node.$value };
    const names = Object.keys(modes);
    const scalar = {};
    for (const m of names) {
      const mv = modes[m];
      scalar[m] = mv && typeof mv === "object" && "value" in mv ? mv.value : mv;
    }
    const def = defaultMode[amaca.collection];
    const base = def && def in scalar ? scalar[def] : node.$value != null ? node.$value : scalar[names[0]];
    const out = { $type: node.$type, $value: base };
    if (names.length > 1) out.$extensions = { modes: scalar }; // normalizer lifts → $modes
    return out;
  }
  function walk(node) {
    if (node && typeof node === "object" && "$type" in node && "$value" in node) return leaf(node);
    const out = {};
    for (const k of Object.keys(node || {})) if (!k.startsWith("$")) out[k] = walk(node[k]);
    return out;
  }
  return walk(tokens);
}

/** Cheap shape guard for the route. Returns an error string, or null when OK. */
export function validateFigmaPayload(payload) {
  if (!payload || typeof payload !== "object") return "missing payload";
  if (!payload.tokens || typeof payload.tokens !== "object") return "payload.tokens missing";
  if (payload.meta && payload.meta.source && payload.meta.source !== "figma-plugin") return "unexpected source";
  return null;
}

/** A corpus/session-friendly slug from the payload meta (fileName → fileKey → "figma"). */
export function payloadName(payload) {
  const raw = (payload && payload.meta && (payload.meta.fileName || payload.meta.fileKey)) || "figma";
  return String(raw).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "figma";
}
