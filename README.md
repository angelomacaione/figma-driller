# figma-driller

An owned, **plugin-free** reader for Figma `.fig` files. Give it a `.fig` buffer and it
decodes the file (ZIP → `canvas.fig` Kiwi message) and extracts the design-token system —
**Variables** (collections, modes, aliases, scopes-typed values) and **published Styles**
(fill / text / effect / grid) — into a clean **DTCG** tokens object, plus a structured report
of what it found and any incoherences.

No Figma plugin, no login, no Figma REST API. The `.fig` is self-describing (its Kiwi schema
is embedded in the file), so the whole pipeline runs locally on the byte buffer.

> Extracted from a larger project. The four files under `src/api/` are self-contained
> (only `kiwi-schema`, `pako`, `fzstd` + Node built-ins) and carry no dependency back on the
> original codebase.

## Install

```bash
npm install
npm test
```

Requires Node ≥ 20 (uses `node:worker_threads`, `node --test`).

## Quick use

```js
import { figFileToDtcg } from "./src/api/ingest-fig.js";
import fs from "node:fs";

const buf = fs.readFileSync("./MyKit.fig");
const result = figFileToDtcg(buf, { fileName: "MyKit.fig" });

if (result.declined) {
  // pure-canvas file: no Variables and no published Styles
  console.log(result.reason);
} else {
  result.dtcg;          // DTCG tokens object (nested; $value + lifted $modes)
  result.payload;       // intermediate canonical payload (collections + nested tokens)
  result.styles;        // named/published styles (fill/text/effect/grid)
  result.incoherences;  // ranked + deduped conflicts (var↔style, dup collections…)
  result.stats;         // { variables, tokensEmitted, aliasesResolved, aliasesExternal,
                        //   styles, modes, incoherenceSummary{ total, byKind, bySeverity } }
}
```

### Large / memory-bounded decode

A canvas-heavy mega-kit can spike memory. `fig-worker.js` runs the decode in an isolated,
memory- and time-bounded worker thread so a runaway file is declined cleanly instead of
crashing the host process:

```js
import { figFileToDtcgIsolated } from "./src/api/fig-worker.js";

const result = await figFileToDtcgIsolated(buf, { fileName: "Huge.fig" }, {
  maxOldGenerationSizeMb: 384, // V8 heap ceiling for the worker
  timeoutMs: 20000,
});
// result is the normal figFileToDtcg output, OR
//   { overLimit: true, reason }  → exceeded the memory/time budget
//   { error }                    → corrupt / unsupported .fig
```

Even with the worker, the real memory wall is the **upload byte cap** you enforce before
calling the reader (the decode peak is dominated by off-heap buffers; the heap ceiling is a
partial guard). In the original product the cap was ~75 MB, sized above the worst real specimen
(~55 MB → ~250 MB peak with the lazy decoder).

## What it extracts

- **Variables** → collections + per-mode values; multi-mode collections keep every `$mode`.
- **Alias resolution, 3 classes**: in-file GUID references · library snapshots resolved by
  publish key (`assetRef`) · truly-external references kept as `partial`. Cycle-safe.
- **Typing, scopes-first**: `variableScopes` → `dimension` / `fontFamily` / `number`, with a
  name-based fallback; colors `{r,g,b,a}` → hex (opaque) or `rgba()` (translucent).
- **Styles**: only **named / published** styles (`isPublishable === true`).
- **Soft-deleted** variables/styles are excluded.
- **Incoherences**: var↔style overlaps and duplicate-collection conflicts are surfaced (ranked,
  deduped) rather than silently merged — `info` (a style mirroring a variable) vs `warn`
  (a real conflict).
- **Empty guard**: a file with no Variables and no published Styles (pure canvas) returns
  `{ declined: true, reason }` instead of emitting garbage.

## Module map

| File | Role |
|---|---|
| `src/api/ingest-fig.js` | Main reader: ZIP/Kiwi decode + token/style extraction → canonical payload → DTCG. Public: `figFileToDtcg`, `figFileToPayload`, `figDecode`, `figMessageToResult`, `figName`, `summarizeIncoherences`, plus low-level `unzipCanvas` / `decodeCanvas` / `decodeFig` / `encodeColor` / `inferType`. |
| `src/api/ingest-figma.js` | Pure transform `figmaPayloadToDtcg` (canonical payload → DTCG tokens). The reader reuses this; included so the package stands alone. |
| `src/api/fig-lazy-decode.js` | Field-pruned lazy Kiwi decoder — streams `nodeChanges`, keeps only token-relevant nodes/fields, skips canvas geometry. Big memory/time win on large files; deep-equal to the reference decode. Default path in `figFileToPayload`. |
| `src/api/fig-worker.js` | Isolated, memory/time-bounded decode in a worker thread (`figFileToDtcgIsolated`). |

## Tests

```bash
npm test            # unit tests (synthetic .fig fixtures, no real files needed)
```

The suite is built on synthetic Kiwi fixtures (`test/_fig-synth.js`) so it runs with no real
`.fig` files. A handful of **parity tests against real specimens** are gated — point an env var
at a folder of `.fig` files to run them:

```bash
AMACA_FIG_DIR=/path/to/fig-specimens npm test
```

(Real third-party `.fig` files are intentionally not committed — IP + size.)

## License

MIT (see `package.json`). Adjust to taste before sharing.
