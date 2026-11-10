# Step 7 Plan: Recognise The Text

This plan turns the line boxes from step 6 into text. It follows the same rule as the
earlier steps: one branch, one loadable build, one measurable result.

The target project is GPL-3.0, so nothing here is copied from it. Its code is read as a
specification, and every function below is written again for this repository.

## What The Target Project Does

| Stage | File | Facts we can reuse |
| --- | --- | --- |
| Detect | `pipeline/detect/onnxDetect.ts` | 1024 x 1024 input, mask to quads, per-region `fontSize` and `direction` |
| OCR input | `pipeline/ocr/paddleocrPreprocess.ts` | crop, rotate a vertical line 90 degrees, resize to height 48, width at most 320, RGB, NCHW, `value / 127.5 - 1` |
| OCR decode | `pipeline/ocr/paddleocrDecode.ts` | greedy CTC, index 0 is blank, collapse repeats, confidence is the geometric mean of the kept probabilities |
| Charset | `public/models/paddleocr_v6_dict.txt` | 18,708 lines, index 0 blank, a space appended at the end |
| Model | `public/models/models.json` | `PP-OCRv6_medium_rec.onnx`, 76,554,979 bytes, input `[48, 320]` |

## Our Constraints

- The extension stays a MV3 extension: OCR runs in the existing offscreen document.
- The download budget grows by 76 MB for the recognition model plus 75 KB for the dictionary.
- The session must stay warm, so the recogniser lives beside the detector in the same document.
- One page must stay under a few seconds on a 2020 laptop.

## Tasks In Order

### T1. Add the model to the asset script

- Extend `scripts/prepare-assets.ts` with the recognition model and the dictionary.
- Record the size and the sha256 in `DETECTOR_*` style constants, named `OCR_*`.
- Acceptance: `npm run prepare:assets` produces both files under `public/models/`, and the hash check fails on a corrupted download.

### T2. Separate furigana from the main line

- A glyph whose size is below 0.6 times the median glyph of its line is ruby, not text.
- Keep ruby boxes in a `ruby` array on the line, and crop the main line without them.
- Acceptance: the page used in step 6 yields lines whose crops hold no small kana beside a kanji.

### T3. Build the recogniser input

- New file `src/lib/ocr/prepare.ts`.
- Crop the line, rotate 90 degrees clockwise when `direction` is `vertical`, resize to height 48 with the width capped at 320, keep the aspect ratio.
- Emit a Float32Array in NCHW order, RGB, `value / 127.5 - 1`.
- Acceptance: a unit test compares the produced dims and a few sample values against a fixture.

### T4. Run the session

- New file `src/lib/ocr/recognize.ts`.
- Load the session with `InferenceSession.create(chrome.runtime.getURL(OCR_MODEL_PATH))`.
- Run one line per call; batch later if the timing needs it.
- Acceptance: the first line of a page returns text, and the warm call stays under 200 ms per line.

### T5. Decode the logits

- New file `src/lib/ocr/decode.ts`.
- Greedy CTC: take the argmax per time step, skip index 0, collapse a repeated index, map through the charset, average the log probabilities.
- Acceptance: a unit test with a hand-built logits array returns the expected text and a confidence in 0 to 1.

### T6. Carry the text through the protocol

- Add `text` and `confidence` to `BoxData`, so one line carries geometry, direction, text, and score.
- Response and popup show the text under each crop.
- Acceptance: the popup lists every line with its text; a failed recognition shows `{ ok: false }` with the reason.

### T7. Filter misrecognitions

- New file `src/lib/ocr/filters.ts`.
- Rules first: empty text, text that is only punctuation, confidence under 0.5, and text that repeats the same glyph more than three times.
- Acceptance: the test page drops obvious noise lines and keeps the dialogue.

### T8. Measure and report

- Log lines, characters, total milliseconds, and how many lines were filtered.
- Acceptance: one page under three seconds cold and under 800 ms warm on the same machine used in step 5.

## Out Of Scope For Step 7

- Translation, erasing, and typesetting stay for later steps.
- Quad geometry and rotated lines stay axis aligned until a page fails on them.
- Panel detection stays out; reading order keeps the step 6 heuristic.

## Risks

| Risk | Mitigation |
| --- | --- |
| The 76 MB download doubles the cold start | Load the recogniser on the first OCR request, not on the first page |
| The dictionary is large and must stay in sync with the model | Hash both files in `prepare:assets`, and read the dictionary once per document |
| Vertical text rotated the wrong way produces garbage | Test one vertical and one horizontal line before wiring the UI |
| Ruby merging still confuses the crop | Do T2 before T3, so the crop never holds ruby |

## Open Questions

1. Does the recognition model ship under Apache-2.0 like the rest of PaddleOCR? Confirm before publishing the article.
2. Should the dictionary live in the bundle or in `public/`? The bundle is 146 kB already, and 75 kB more is acceptable, but `public/` keeps the JS small.
3. Do we need a second model for horizontal text, or does one recogniser handle both after rotation?
