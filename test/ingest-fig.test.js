import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  figMessageToResult, figFileToDtcg, figFileToPayload, decodeFig,
  encodeColor, inferType, figName, summarizeIncoherences,
} from "../src/api/ingest-fig.js";
import { figmaPayloadToDtcg } from "../src/api/ingest-figma.js";
import { buildSynthetic } from "./_fig-synth.js";

// ---- synthetic Kiwi-message builders (mirror the real .fig nodeChanges shapes) ----
const guid = (s, l) => ({ sessionID: s, localID: l });
const mode = (s, l, name) => ({ id: guid(s, l), name });
const colorVal = (r, g, b, a = 1) => ({ value: { colorValue: { r, g, b, a } }, dataType: "COLOR", resolvedDataType: "COLOR" });
const floatVal = (n) => ({ value: { floatValue: n }, dataType: "FLOAT", resolvedDataType: "FLOAT" });
const aliasGuid = (s, l) => ({ value: { alias: { guid: guid(s, l) } }, dataType: "ALIAS", resolvedDataType: "COLOR" });
const aliasKey = (key) => ({ value: { alias: { assetRef: { key, version: "1:1" } } }, dataType: "ALIAS", resolvedDataType: "COLOR" });

const set = (s, l, name, modes, extra = {}) => ({ type: "VARIABLE_SET", guid: guid(s, l), name, variableSetModes: modes, ...extra });
const variable = (s, l, name, setSL, resolvedType, entries, extra = {}) => ({
  type: "VARIABLE", guid: guid(s, l), name, variableSetID: { guid: guid(setSL[0], setSL[1]) },
  variableResolvedType: resolvedType, variableDataValues: { entries }, ...extra,
});
const entry = (mSL, vd) => ({ modeID: guid(mSL[0], mSL[1]), variableData: vd });

// ---------------------------------------------------------------------------

test("encodeColor: hex when opaque, rgba when translucent", () => {
  assert.equal(encodeColor({ r: 1, g: 1, b: 1, a: 1 }), "#FFFFFF");
  assert.equal(encodeColor({ r: 0.1411, g: 0.2156, b: 0.5098, a: 1 }), "#243782");
  assert.equal(encodeColor({ r: 0, g: 0, b: 0, a: 0.05 }), "rgba(0, 0, 0, 0.05)");
});

test("inferType: scopes-first, then name fallback", () => {
  assert.equal(inferType("COLOR", []), "color");
  assert.equal(inferType("BOOLEAN", []), "boolean");
  assert.equal(inferType("STRING", ["FONT_FAMILY"]), "fontFamily");
  assert.equal(inferType("FLOAT", ["CORNER_RADIUS"]), "dimension");
  assert.equal(inferType("FLOAT", ["OPACITY"]), "number");
  assert.equal(inferType("FLOAT", [], "spacing/4"), "dimension"); // no scopes → name heuristic
  assert.equal(inferType("FLOAT", [], "z-index"), "number");
});

test("DOCG-shape: one collection, 2 modes, color → nested tokens + per-mode values", () => {
  const msg = { nodeChanges: [
    set(1, 1, "Color Palette", [mode(1, 0, "Light Mode"), mode(1, 1, "Dark Mode")]),
    variable(1, 2, "Primary/Stellantis Blue", [1, 1], "COLOR", [
      entry([1, 0], colorVal(0.1411, 0.2156, 0.5098, 1)),
      entry([1, 1], colorVal(0.996, 0.984, 1, 1)),
    ]),
  ] };
  const r = figMessageToResult(msg, { fileName: "docg" });
  assert.equal(r.declined, false);
  assert.equal(r.collections.length, 1);
  assert.equal(r.collections[0].defaultMode, "Light Mode");
  const leaf = r.tokens["Color Palette"]["Primary"]["Stellantis Blue"];
  assert.equal(leaf.$type, "color");
  assert.equal(leaf.$value, "#243782"); // default = Light Mode (0.5098*255=130=0x82)
  assert.deepEqual(leaf.$extensions.amaca.modes, {
    "Light Mode": { value: "#243782" }, "Dark Mode": { value: "#FEFBFF" },
  });
  assert.equal(r.stats.tokensEmitted, 1);
});

test("in-file alias by GUID → resolved value + aliasRef label", () => {
  const msg = { nodeChanges: [
    set(1, 1, "Primitives", [mode(1, 0, "Value")]),
    variable(1, 2, "blue/600", [1, 1], "COLOR", [entry([1, 0], colorVal(0, 0, 1, 1))]),
    set(2, 1, "Semantic", [mode(2, 0, "Light")]),
    variable(2, 2, "color/primary", [2, 1], "COLOR", [entry([2, 0], aliasGuid(1, 2))]),
  ] };
  const r = figMessageToResult(msg);
  const leaf = r.tokens["Semantic"]["color"]["primary"];
  assert.equal(leaf.$extensions.amaca.modes["Light"].value, "#0000FF"); // resolved through the alias
  assert.equal(leaf.$extensions.amaca.modes["Light"].aliasRef, "Primitives::blue/600");
  assert.equal(r.stats.aliasesExternal, 0);
});

test("assetRef alias resolves by publish key to an in-file variable (library snapshot)", () => {
  const msg = { nodeChanges: [
    set(1, 1, "Tailwind", [mode(1, 0, "Mode 1")]),
    variable(1, 2, "slate/950", [1, 1], "COLOR", [entry([1, 0], colorVal(0.008, 0.024, 0.09, 1))], { key: "PUBKEY_SLATE950" }),
    set(2, 1, "shadcn", [mode(2, 0, "dark")]),
    variable(2, 2, "background", [2, 1], "COLOR", [entry([2, 0], aliasKey("PUBKEY_SLATE950"))]),
  ] };
  const r = figMessageToResult(msg);
  const leaf = r.tokens["shadcn"]["background"];
  assert.equal(leaf.$extensions.amaca.modes["dark"].value, "#020617"); // resolved via key, NOT external
  assert.equal(leaf.$extensions.amaca.modes["dark"].aliasRef, "Tailwind::slate/950");
  assert.equal(r.stats.aliasesExternal, 0);
});

test("truly-external alias (key not in file) → partial, value null, never invented", () => {
  const msg = { nodeChanges: [
    set(2, 1, "shadcn", [mode(2, 0, "dark")]),
    variable(2, 2, "background", [2, 1], "COLOR", [entry([2, 0], aliasKey("MISSING_LIB_KEY"))]),
  ] };
  const r = figMessageToResult(msg);
  const m = r.tokens["shadcn"]["background"].$extensions.amaca.modes["dark"];
  assert.equal(m.value, null);
  assert.equal(m.partial, true);
  assert.match(m.aliasRef, /^library:MISSING_LIB_KEY/);
  assert.equal(r.stats.aliasesExternal, 1);
});

test("FLOAT typing via scopes; STRING fontFamily", () => {
  const msg = { nodeChanges: [
    set(1, 1, "tokens", [mode(1, 0, "Mode 1")]),
    variable(1, 2, "radius/sm", [1, 1], "FLOAT", [entry([1, 0], floatVal(4))], { variableScopes: ["CORNER_RADIUS"] }),
    variable(1, 3, "font/base", [1, 1], "STRING", [entry([1, 0], { value: { textValue: "Inter" }, dataType: "STRING", resolvedDataType: "STRING" })], { variableScopes: ["FONT_FAMILY"] }),
  ] };
  const r = figMessageToResult(msg);
  assert.equal(r.tokens["tokens"]["radius"]["sm"].$type, "dimension");
  assert.equal(r.tokens["tokens"]["radius"]["sm"].$value, 4);
  assert.equal(r.tokens["tokens"]["font"]["base"].$type, "fontFamily");
  assert.equal(r.tokens["tokens"]["font"]["base"].$value, "Inter");
});

test("soft-deleted variables and styles are excluded", () => {
  const msg = { nodeChanges: [
    set(1, 1, "C", [mode(1, 0, "M")]),
    variable(1, 2, "live", [1, 1], "COLOR", [entry([1, 0], colorVal(0, 0, 0, 1))]),
    variable(1, 3, "dead", [1, 1], "COLOR", [entry([1, 0], colorVal(1, 1, 1, 1))], { isSoftDeleted: true }),
  ] };
  const r = figMessageToResult(msg);
  assert.equal(r.stats.tokensEmitted, 1);
  assert.ok(r.tokens["C"]["live"]);
  assert.ok(!r.tokens["C"]["dead"]);
});

test("empty file (no variables, no published styles) → declined honestly", () => {
  const msg = { nodeChanges: [
    { type: "FRAME", guid: guid(1, 1), name: "Frame 1" },
    { type: "TEXT", guid: guid(1, 2), name: "label" },
  ] };
  const r = figMessageToResult(msg);
  assert.equal(r.declined, true);
  assert.match(r.reason, /no Variables or published Styles/i);
  assert.deepEqual(r.tokens, {});
});

test("named/published styles only; var↔style overlap surfaced as incoherence", () => {
  const msg = { nodeChanges: [
    set(1, 1, "C", [mode(1, 0, "M")]),
    variable(1, 2, "brand/white", [1, 1], "COLOR", [entry([1, 0], colorVal(1, 1, 1, 1))]),
    // a published FILL style duplicating the variable's white
    { type: "FRAME", styleType: "FILL", isPublishable: true, name: "Primary/White", guid: guid(2, 1), fillPaints: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }] },
    // an UNpublished fill node must be ignored (not a named style)
    { type: "FRAME", styleType: "FILL", isPublishable: false, name: "instance fill", guid: guid(2, 2), fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }] },
  ] };
  const r = figMessageToResult(msg);
  assert.equal(r.styles.length, 1);
  assert.equal(r.styles[0].name, "Primary/White");
  assert.equal(r.styles[0].value, "#FFFFFF");
  assert.ok(r.incoherences.some((i) => i.kind === "var-vs-style"));
});

test("message → payload → figmaPayloadToDtcg seam (the reuse contract)", () => {
  const msg = { nodeChanges: [
    set(1, 1, "C", [mode(1, 0, "Light"), mode(1, 1, "Dark")]),
    variable(1, 2, "bg", [1, 1], "COLOR", [entry([1, 0], colorVal(1, 1, 1, 1)), entry([1, 1], colorVal(0, 0, 0, 1))]),
  ] };
  const res = figMessageToResult(msg, { fileName: "x" });
  const payload = {
    meta: { source: "figma-plugin" },
    collections: res.collections.map(({ name, defaultMode }) => ({ name, defaultMode })),
    tokens: res.tokens,
  };
  const dtcg = figmaPayloadToDtcg(payload); // must not throw; produces the downstream shape
  const leaf = dtcg["C"]["bg"];
  assert.equal(leaf.$type, "color");
  assert.equal(leaf.$value, "#FFFFFF");               // default mode (Light)
  assert.deepEqual(leaf.$extensions.modes, { Light: "#FFFFFF", Dark: "#000000" }); // normalizer 0.2 lift raises → $modes
});

test("figName slugifies", () => {
  assert.equal(figName("🌞 NEW DOCG Design System.fig"), "new-docg-design-system");
  assert.equal(figName(""), "figma");
});

// ---- incoherence ranking + dedup ----
test("summarizeIncoherences: many style overlaps on one value collapse to a single info entry", () => {
  const raw = [
    { kind: "var-vs-style", value: "#FFFFFF", style: "White A", variables: ["C/white"] },
    { kind: "var-vs-style", value: "#FFFFFF", style: "White B", variables: ["C/white"] },
    { kind: "var-vs-style", value: "#FFFFFF", style: "White C", variables: ["C/white"] },
    { kind: "var-vs-style", value: "#000000", style: "Black", variables: ["C/black"] },
  ];
  const { items, summary } = summarizeIncoherences(raw);
  const white = items.find((i) => i.value === "#FFFFFF");
  assert.equal(white.count, 3, "3 styles collapse to one entry with count 3");
  assert.equal(white.severity, "info", "a style mirroring a variable colour is informational");
  assert.equal(items.filter((i) => i.kind === "var-vs-style").length, 2, "one entry per distinct value");
  assert.equal(summary.byKind["var-vs-style"], 2);
});

test("summarizeIncoherences: dup-variable is a warning and sorts above info; sorted by count", () => {
  const raw = [
    { kind: "var-vs-style", value: "#111", style: "s1", variables: ["t"] },
    { kind: "var-vs-style", value: "#222", style: "a", variables: ["x"] },
    { kind: "var-vs-style", value: "#222", style: "b", variables: ["x"] },
    { kind: "dup-variable", key: "Coll/brand/blue" },
  ];
  const { items } = summarizeIncoherences(raw);
  assert.equal(items[0].kind, "dup-variable", "warn sorts before info");
  assert.equal(items[0].severity, "warn");
  const infos = items.filter((i) => i.severity === "info");
  assert.ok(infos[0].count >= infos[1].count, "info entries sorted by count desc");
});

test("ranking is wired into figMessageToResult + stats.incoherenceSummary", () => {
  const msg = { nodeChanges: [
    set(1, 1, "C", [mode(1, 0, "M")]),
    variable(1, 2, "white", [1, 1], "COLOR", [entry([1, 0], colorVal(1, 1, 1, 1))]),
    { type: "FRAME", styleType: "FILL", isPublishable: true, name: "Snow", guid: guid(2, 1), fillPaints: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }] },
    { type: "FRAME", styleType: "FILL", isPublishable: true, name: "Paper", guid: guid(2, 2), fillPaints: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }] },
  ] };
  const r = figMessageToResult(msg);
  const white = r.incoherences.find((i) => i.kind === "var-vs-style");
  assert.equal(white.count, 2, "two styles duplicating #FFFFFF → one entry, count 2");
  assert.equal(r.stats.incoherenceSummary.total, r.incoherences.length);
  assert.equal(r.stats.incoherenceSummary.bySeverity.info, 1);
});

// ---- binary decode smoke (skipped unless the real specimens are present locally) ----
// Third-party .fig files are NOT committed (IP + size); this validates the ZIP+Kiwi decode path
// when the specimens happen to be available in the local uploads dir.
// Specimens are uncommitted (IP + size); point AMACA_FIG_DIR at a local dir holding the .fig files
// to run these (CI-skip otherwise). Same gating convention as the fig-lazy-decode / fig-worker tests.
const UPLOADS = process.env.AMACA_FIG_DIR || "";
const haveSpecimens = (() => { try { return !!UPLOADS && fs.readdirSync(UPLOADS).some((f) => f.endsWith(".fig")); } catch { return false; } })();

test("binary decode: real specimens parse without crashing; empty one declines", { skip: !haveSpecimens }, () => {
  for (const f of fs.readdirSync(UPLOADS).filter((x) => x.endsWith(".fig"))) {
    const r = figFileToDtcg(fs.readFileSync(path.join(UPLOADS, f)), { fileName: f });
    if (/google material design/i.test(f)) { assert.equal(r.declined, true); continue; }
    assert.equal(r.declined, false, `${f} should yield tokens`);
    assert.ok(r.stats.tokensEmitted > 0, `${f} should emit tokens`);
    assert.equal(r.stats.aliasesExternal, 0, `${f} should have no truly-external aliases`);
    assert.ok(r.dtcg && typeof r.dtcg === "object");
  }
});
