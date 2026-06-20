/**
 * Isolated `.fig` decode — runs the ZIP + Kiwi decode + token extraction in a worker
 * thread with a hard V8 heap ceiling (`resourceLimits.maxOldGenerationSizeMb`). A `.fig` decodes
 * into a large in-memory graph; the field-pruned lazy decoder (fig-lazy-decode.js) keeps the peak
 * low for normal files, but a pathological/huge upload could still spike. Bounding the decode in a
 * worker means a runaway allocation aborts the WORKER (caught → friendly decline) instead of
 * OOM-killing the whole host process (e.g. a small 512MB instance).
 *
 * Self-referencing module: imported on the main thread it only exports `figFileToDtcgIsolated`;
 * loaded AS a worker (isMainThread === false) it runs the decode loop. The buffer is transferred
 * (zero-copy) in; the result crosses back as a JSON string (the token output is plain JSON — no
 * BigInt on the kept path — so this is safe and avoids structured-clone surprises).
 *
 * NOTE (honest caveat): a worker thread shares the process RSS, so the heap cap bounds the dominant
 * V8 heap growth but is not full OS-level memory isolation (a child process would be). Combined with
 * the lazy decoder + an upload byte cap enforced by the caller, it keeps realistic kits (a ~55MB
 * specimen peaks ~251MB) well inside budget while aborting true runaways.
 */

import { Worker, isMainThread, parentPort } from "node:worker_threads";

// Default heap ceiling for the decode worker. The worst real specimen (~55MB) decodes lazily
// in ~130MB of heap; 384MB leaves headroom for larger token-dense files while still aborting a
// pathological decode before the instance OOMs. Overridable via FIG_DECODE_HEAP_MB.
const DEFAULT_HEAP_MB = Number(process.env.FIG_DECODE_HEAP_MB) || 384;
const DEFAULT_TIMEOUT_MS = Number(process.env.FIG_DECODE_TIMEOUT_MS) || 20000;

if (!isMainThread && parentPort) {
  // Worker side: bytes in → figFileToDtcg → JSON out. Never throw to the top level.
  parentPort.once("message", async ({ ab, opts }) => {
    try {
      const { figFileToDtcg } = await import("./ingest-fig.js");
      const result = figFileToDtcg(Buffer.from(ab), opts || {});
      parentPort.postMessage({ ok: true, json: JSON.stringify(result) });
    } catch (e) {
      parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

/**
 * Decode a `.fig` buffer in an isolated, memory-bounded worker.
 * Resolves (never rejects) to one of:
 *   - the figFileToDtcg result `{ declined?, dtcg, payload, styles, incoherences, stats }`
 *   - `{ overLimit: true, reason }`  → decode exceeded the memory/time budget (friendly 413)
 *   - `{ error }`                    → the `.fig` could not be decoded (corrupt / unsupported)
 */
export function figFileToDtcgIsolated(buf, opts = {}, { maxOldGenerationSizeMb = DEFAULT_HEAP_MB, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    // Copy into a standalone ArrayBuffer we can transfer (a Buffer may be a view onto a shared pool).
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    let settled = false;
    let worker;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { worker && worker.terminate(); } catch { /* already gone */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish({ overLimit: true, reason: "fig decode timed out" }), timeoutMs);
    try {
      worker = new Worker(new URL("./fig-worker.js", import.meta.url), { resourceLimits: { maxOldGenerationSizeMb } });
    } catch (e) {
      // worker_threads unavailable / spawn failed → caller decides (no isolation this run).
      return finish({ error: "decode worker unavailable: " + String((e && e.message) || e), workerUnavailable: true });
    }
    worker.on("message", (m) => {
      if (m && m.ok) { try { finish(JSON.parse(m.json)); } catch { finish({ error: "decode result parse failed" }); } }
      else finish({ error: (m && m.error) || "fig decode failed" });
    });
    // A heap-cap breach surfaces as an 'error' (V8 "heap out of memory") or a non-zero 'exit' →
    // treat as over-limit, never a crash of the main instance.
    worker.on("error", () => finish({ overLimit: true, reason: "fig too large or complex to import" }));
    worker.on("exit", (code) => { if (code !== 0) finish({ overLimit: true, reason: "fig decode worker exited" }); });
    worker.postMessage({ ab, opts }, [ab]);
  });
}
