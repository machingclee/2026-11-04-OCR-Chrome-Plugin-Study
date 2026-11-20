# Loop record — detection that never answers

- **When** 2026-11-19 03:27 → 04:10 (Hong Kong time)
- **Where** the batch pill (`src/content-script/pickImage.ts`), the offscreen pass
  (`src/offscreen/main.ts`), the four model loaders, the service-worker watchdog
  (`src/background/index.ts`)
- **Rounds** 1; no browser measurement yet, so this record ends on a bounded
  failure rather than a confirmed cause
- **Outcome** not confirmed: the hang can no longer be silent, and the default
  backend no longer touches the GPU; the exact wait that hung is still to be
  named from the new logs

## The three questions

**What should change.** The batch pill sat at
`Processing 1/1 images · Detecting boxes` with its Cancel button and no error,
and the browser would not open the extension popup at that point. A pass that
never returns must end in an error that names the model and the stage, and a
pass that is only slow must say how long it has been running. If a GPU failure
is what takes the browser with it, the default path must not use the GPU.

**How to verify.** Load the page that hung, translate one image, and read the
offscreen document's console (`chrome://extensions` → Inspect views →
offscreen.html). It now prints one `[detect]` line per stage and one
`[inference]` line per model, with the backend each ran on. A stalled pass ends
with `[detect] failed at "<stage>"` and the pill prints that message.

**Done when.** No wait in the detection path is unbounded: image download 20 s,
image decode 60 s, model load 180 s, inference pass 120 s, and a 10-minute
service-worker watchdog around the whole detection. A missed deadline is
returned to the page as text, not left pending. `npm run typecheck` is clean,
one regression case passes, and `dist` is rebuilt. On the user's side: the same
page either finishes or says which stage failed.

## What the report said

Two facts, from the screenshot and the message:

- The pill was in its `running` branch (`Processing N/M images`), so the batch
  had started and the service worker was still holding the item as `running`.
- The pill never received the `calling` stage, which the worker sends only
  after `runDetection` returns. So the pass was inside the detection call, not
  in translation.
- The extension popup would not open. That is outside the page, which points at
  the browser rather than at the content script: a wedged GPU process is the one
  failure mode here that makes Chrome's own UI unresponsive.

Inside `runDetection`, four waits had no deadline and could stay pending
forever: `fetch` of the page image, `createImageBitmap`, and the ONNX
`InferenceSession.create` / `session.run` calls. All four inference modules
preferred WebGPU (`executionProviders: ['webgpu', 'wasm']`), and the fallback
ran only when a call *rejected* — never when it hung. The regression harness runs
the same pipeline on WASM only (see `docs/detection-pipeline.md`), so the WebGPU
path had no automated check.

A second problem made any one hang self-perpetuating: `resumeBatch()` at
service-worker start-up resumed every batch still marked `running`, so each
wake-up after a worker death re-ran the detection that had just hung.

## What changed

| Area | Change |
| --- | --- |
| `src/shared/timing.ts` | `withTimeout`, kept free of the ONNX runtime so the worker can use it |
| `src/lib/onnx.ts` | One bounded loader/runner for all four models, with the device read from `chrome.storage.local` (default `webgpu`) and a load that cannot use the GPU reported rather than absorbed |
| `src/lib/detect/inference.ts`, `bubble.ts`, `ocr/recognize.ts`, `inpaint.ts` | Use the shared loader; a rejected load is no longer cached (the bubble loader used to cache a rejected fallback) |
| `src/lib/ocr/charset.ts` | The dictionary fetch has a 15 s deadline |
| `src/offscreen/main.ts` | Writes the current stage to `chrome.storage.local` (`detectStage`) and logs `[detect]`; bounds the image download and decode; failures carry the stage and the time spent in it |
| `src/background/index.ts` | A 10-minute watchdog around the offscreen call, whose timeout reads the stored stage; a batch left `running` for more than 60 s is closed instead of re-run |
| `src/content-script/pickImage.ts` | The pill shows elapsed seconds in the current stage, prints the first failed item's reason for 15 s, and the Cancel button says `Cancelling…` |
| `src/App.tsx` | The **Inference device** menu writes the setting; the offscreen document drops its sessions on a change, so the next detection runs on the new device |
| `src/shared/progress.ts`, `src/background/index.ts` | Stage updates travel from the offscreen document through the worker to the page, because a content script cannot hear a runtime message |

## What did not change

- The detection geometry, the reading prompt and the typesetting. The pipeline
  itself is untouched; only its waits are bounded.
- The WASM numbers the harness measures. The default backend is now the one the
  harness exercises, so the measurements apply to the build.
- `docs/detection-pipeline.md` still documents WebGPU as an untested path; the
  backend is now opt-in through `chrome.storage.local.inferenceBackend`.

## Follow-up, same day

The hang did not come back on CPU, but CPU detection was too slow to keep. The
device became a popup setting (`Inference device`, saved on change) and the
default went back to WebGPU. Three corrections followed, each from a screenshot
of the pill:

1. The pill only said `Detecting boxes`, so a 40-second pass did not say what it
   was doing. The offscreen document now announces each stage
   (`downloading the page image`, `detecting text lines`, `reading N blocks`),
   the worker relays it to the page, and the pill shows it with its own seconds.
2. The next screenshot said `Running the recogniser (24 s)`. The pill now also
   shows the per-call cost (`· 620 ms/run`) and the line it is on (`line 7/48`),
   so throughput and a stuck line cannot look alike.
3. A model can be configured for the GPU and still run on the CPU: ONNX Runtime
   treats a WebGPU provider that fails to attach as a warning and continues on
   WASM. The loader now asks for `['webgpu']` alone first, then
   `['webgpu', 'wasm']`, then `['wasm']`, and reports the step that succeeded.
   A `webgpu` claim in the popup is now a checked claim.

### The number this produced

Measured in Node against `ppocr_v6_medium_rec.onnx` on the WASM provider
(`onnxruntime-web`, one thread, warm):

| batch | time |
| --- | --- |
| 1 line | 553–851 ms |
| 4 lines | 2,167 ms |
| 8 lines | 4,553 ms |
| 16 lines | 9,392 ms |

The cost is linear because the output layer is 40 steps by 18,710 classes per
line, so batching does not buy anything. At about 0.6 s a line, the 24-second
"Running the recogniser" is roughly 40 lines — the recogniser was on the CPU.
On the GPU the same crop is tens of milliseconds, which is why the staged
provider order matters more than any batching change.

Not yet decided: if the GPU cannot run this model at all (a recurrent output
head is a common reason), the recogniser will report `wasm` and stay at about
0.6 s a line. The lever then is not the device but the work: the on-device pass
exists to quote columns to the cloud reader, and skipping it when DeepSeek reads
the blocks would remove most of the 24 s at the cost of the column split the
incline case depends on.
