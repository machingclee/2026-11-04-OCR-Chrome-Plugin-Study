# Handoff: the erase and the typeset still look wrong

This file hands the remaining work to another agent. Read it before touching any
code, because several obvious fixes have already been tried and reverted.

## The project

A Manifest V3 Chrome extension that translates a comic page in place.

| Repo | Path | Branch |
| --- | --- | --- |
| The extension | `/Users/chingcheonglee/Repos/Javascript/2026-11-04-OCR-Chrome-Plugin-Study` | `step-10-typeset-quality` |
| The article | `/Users/chingcheonglee/Repos/Javascript/machingclee.github.io.source` | `main` |

The article is `app/src/mds/articles/tech/660-build-a-chrome-extension-minimal-mv3-shell.md`
and its `-tc` pair. Every step has its own branch, `step-1` to `step-10`.

The reference implementation being studied is `/Users/chingcheonglee/Repos/Javascript/ShinobuTranslator`.
It is GPL-3.0, and the article's rule is to reimplement its decisions, never copy
its source. Read it for ideas, then write our own code.

## What works

1. Detecting the image on the page, fetching it, decoding it.
2. `det` and `seg` from `comictextdetector.pt.onnx`, tiled for large pages.
3. Lines, blocks, balloons, and reading groups.
4. OCR with `PP-OCRv6_medium_rec.onnx`.
5. Translation through Gemini, DeepSeek, or the browser translator.
6. Canvas typesetting and replacing the `<img>` on the page, with an undo.

## What is still wrong

Two problems, both visible in the last two screenshots.

### Problem 1: the erase leaves a page that still looks broken

Erasing now happens in the offscreen document, stroke by stroke, using the `seg`
mask and the paper colour around each line (`src/lib/erase.ts`):

```
seg > 0.3  ->  a glyph pixel  ->  paint it the median paper colour
grow by one pixel, so the soft edge of a stroke goes too
```

Erasing is limited to the balloon that holds the line, when a balloon is found
(`src/offscreen/main.ts`, the `allow` callback).

It is better than the white rectangles it replaced, but not right yet:

| Symptom | Where to look |
| --- | --- |
| Text sits over untouched artwork, with no cleared area under it | the group box and the balloon disagree, so `allow` blocks every pixel |
| A balloon keeps a ghost of the original strokes | `GLYPH_THRESHOLD = 0.3` is too high for thin strokes |
| The page colour is wrong inside a balloon | `backgroundColour` takes the median of the whole line box, which mixes paper and artwork |

### Problem 2: the typeset lands in the wrong place

The text is painted into the balloon that holds the group, inset by 14 percent
(`src/App.tsx`, `insetBubble`). When the balloon is missing or offset, the text
lands on the artwork and reads as if nothing was cleared.

| Symptom | Where to look |
| --- | --- |
| Chinese text over the drawing, no cleared area behind it | no balloon matched the group, so the group box was used |
| Text smaller than the balloon allows | `insetBubble` with a wrong box |
| Lines overlap each other | two groups resolved to the same balloon |

## What has already been tried

Do not repeat these without a new reason.

1. **White rectangle fill.** The first version filled the box with white. It
   covered artwork wherever the box was wrong, and looked like a sticker.
2. **AOT inpainting model.** `aot_inpaint_512.onnx` was wired, then removed. It
   produced rainbow streaks because the model expects the hole to be zero after
   normalisation. Zeroing the hole (`image *= keep`) fixed the streaks but the
   result was still worse than a colour fill on a white page.
3. **Bubble-first grouping.** Blocks used to win, which split one sentence into
   two translation regions. Balloons now outrank blocks.
4. **Balloon-limited erase.** The current state. It stops the erase from eating
   artwork, but it cannot help when the balloon itself is wrong.

## The reference implementation, for ideas

| Concern | File in ShinobuTranslator |
| --- | --- |
| Mask refinement, dilation sized to the text | `packages/image-pipeline/src/pipeline/maskRefinement/index.ts` |
| Inpainting entry point | `packages/image-pipeline/src/pipeline/inpaint.ts` |
| Balloon detection and region matching | `packages/image-pipeline/src/pipeline/bubbleDetect.ts` |
| Typeset fitting and columns | `packages/image-pipeline/src/pipeline/typeset/` |

The mask refinement dilates the text mask by about ten percent of the text size,
which is how it swallows small kana. That is a cheaper idea than a model and
worth trying before bringing back inpainting.

## Suggested order of work

1. **Verify the erase on its own.** Ask the user to press Detect boxes and look at
   the Text regions strip. If the strip shows clean paper, the erase works and the
   problem is placement.
2. **Fix the balloon join.** For every group, record whether a balloon was found.
   Show that count in the status line, for example `18 groups, 15 with a balloon`.
   A group without a balloon must not paint over artwork: fall back to erasing
   its own box before painting.
3. **Grow the mask instead of filling a box.** Dilate the erased pixels by two or
   three, so a leftover stroke edge is covered without a rectangle.
4. **Only then consider a model.** If the page has textured backgrounds inside
   balloons, a colour fill will always look flat, and an inpainting model becomes
   the right answer. Reuse the removal commit `9893a2a` as the starting point, and
   zero the hole before denormalising.

## Constraints that shaped the current design

- The detector input is fixed at `1 x 3 x 1024 x 1024`, so a batch of two fails.
  Large pages are tiled instead.
- `chrome.storage.session` holds 10 MB. Balloon masks are `Float32Array` and must
  never cross a message boundary; only outlines do.
- The canvas in the popup is tainted by a cross-origin `<img>`, so the bytes are
  fetched again before drawing.
- Model assets are gitignored, downloaded, and hash checked by
  `scripts/prepare-assets.ts`.

## How to check a change

```bash
cd /Users/chingcheonglee/Repos/Javascript/2026-11-04-OCR-Chrome-Plugin-Study
npm run build                      # stamps a build id, so old results retire
```

Then reload the extension at `chrome://extensions`, pick an image, and press
Detect boxes. The status line is the only instrument:

```
23 lines (23 vertical, 0 ruby), 18 read, 4 balloons, 15 grouped, image 1036x1450, 1200 ms
```

Offline probes are faster for detector questions:

```bash
python3 scripts/probe-detector-outputs.py <image>
```

## Acceptance criteria

1. No white rectangle anywhere in the output image.
2. Artwork outside a balloon is pixel identical to the original.
3. No ghost of an original stroke inside a balloon.
4. Every translated line sits inside its balloon, not on the drawing.
5. Undo restores the page exactly, including `srcset`.

## Open questions for the user

1. Are the balloons acceptable, or does the balloon model need to be tuned first?
2. Should text outside a balloon be erased at all, or left alone?
3. Is a flat colour fill acceptable on textured paper, or is a model required?
