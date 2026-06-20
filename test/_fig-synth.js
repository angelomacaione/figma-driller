// Shared test helper (NOT a test file): builds a synthetic raw `fig-kiwi` canvas buffer so the
// `.fig` decode path can be exercised end-to-end without a real (uncommitted) specimen.
// kiwi.parseSchema enforces contiguous field ids; the decoder works by id↔name either way.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const kiwi = require("kiwi-schema");
const pako = require("pako");

const SCHEMA_TEXT = `
enum NodeType { VARIABLE_SET = 1; VARIABLE = 2; FRAME = 3; }
enum VRT { COLOR = 1; FLOAT = 2; STRING = 3; BOOLEAN = 4; }
struct GUID { uint sessionID; uint localID; }
struct Color { float r; float g; float b; float a; }
message VariableAnyValue { Color colorValue = 1; }
message VariableData { VariableAnyValue value = 1; }
message Entry { GUID modeID = 1; VariableData variableData = 2; }
message VariableDataValues { Entry[] entries = 1; }
message Mode { GUID id = 1; string name = 2; }
message VariableSetID { GUID guid = 1; }
message NodeChange {
  GUID guid = 1;
  NodeType type = 2;
  string name = 3;
  bool isSoftDeleted = 4;
  Mode[] variableSetModes = 5;
  VariableSetID variableSetID = 6;
  VRT variableResolvedType = 7;
  VariableDataValues variableDataValues = 8;
  byte[] vectorData = 9;
  int[] junk = 10;
  string descr = 11;
}
message Message { NodeType type = 1; NodeChange[] nodeChanges = 2; string signalName = 3; }
`;
export const G = (s, l) => ({ sessionID: s, localID: l });
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };

/** → { schema, compiled, msg, data, canvas } where `canvas` is a raw fig-kiwi buffer. */
export function buildSynthetic(extraNodes = []) {
  const schema = kiwi.parseSchema(SCHEMA_TEXT);
  const compiled = kiwi.compileSchema(schema);
  const msg = {
    type: "VARIABLE", signalName: "ignored",
    nodeChanges: [
      { type: "VARIABLE_SET", guid: G(1, 1), name: "C", variableSetModes: [{ id: G(1, 0), name: "Light" }] },
      { type: "VARIABLE", guid: G(1, 2), name: "brand/blue", variableSetID: { guid: G(1, 1) }, variableResolvedType: "COLOR",
        variableDataValues: { entries: [{ modeID: G(1, 0), variableData: { value: { colorValue: { r: 0, g: 0, b: 1, a: 1 } } } }] },
        vectorData: new Uint8Array([1, 2, 3, 4, 5]), junk: [7, 8, 9], descr: "skip me" },
      { type: "FRAME", guid: G(2, 1), name: "Frame", vectorData: new Uint8Array(4096), junk: [1, 2, 3, 4, 5] },
      ...extraNodes,
    ],
  };
  const data = Buffer.from(compiled.encodeMessage(msg));
  const sB = Buffer.from(pako.deflateRaw(kiwi.encodeBinarySchema(schema)));
  const dB = Buffer.from(pako.deflateRaw(data));
  const chunk = (b) => Buffer.concat([u32(b.length), b]);
  const canvas = Buffer.concat([Buffer.from("fig-kiwi"), u32(106), chunk(sB), chunk(dB)]);
  return { schema, compiled, msg, data, canvas };
}
