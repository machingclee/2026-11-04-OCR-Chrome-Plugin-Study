# Handoff: restart the renderer

A fresh session should read this before writing code. The detection is the part
that works. The painting is the part that does not, and several rewrites have made
it worse rather than better.

## Repos

| What | Path | Branch |
| --- | --- | --- |
| Extension | `/Users/chingcheonglee/Repos/Javascript/2026-11-04-OCR-Chrome-Plugin-Study` | `step-10-typeset-quality` |
| Blog | `/Users/chingcheonglee/Repos/Javascript/machingclee.github.io.source` | `main` |
| Reference | `/Users/chingcheonglee/Repos/Javascript/ShinobuTranslator` | read only |

The reference project is GPL-3.0. Reimplement its decisions, never copy its code.

## What already works

1. Pick an image from a page, fetch it, decode it.
2. Detect text lines. The boxes are good, which is why this part should be left
   alone. `det` gives a kernel per line, `seg` fills in the columns `det` misses,
   and `blk` carries block level boxes.
3. OCR each line with `PP-OCRv6_medium_rec.onnx`. Text quality is fine.
4. Group lines into balloons and blocks, and order them for reading.
5. Translate the groups through Gemini, DeepSeek, or the browser translator.
6. Paint a page in the popup and offer it as a PNG download.

## What does not work

The painting. Three separate problems, and they are easy to confuse.

| Problem | Symptom |
| --- | --- |
| Erase | white boxes over the artwork, or the whole page turning white |
| Placement | text drawn outside its balloon, sometimes huge |
| Size | one syllable filling half the page |

## The current state of the code

The popup renders; the page is never touched.

```
Popup  →  Worker  →  Offscreen (detect, erase, OCR)  →  Popup (paint, download)
```

| File | Job |
| --- | --- |
| `src/offscreen/main.ts` | one image, detect, fill each line box white, OCR, group |
| `src/lib/detector.ts` | det, blk and seg boxes, tiling for resolution |
| `src/lib/readingOrder.ts` | grouping by balloon then block |
| `src/lib/typeset.ts` | canvas painter, size capped at 26 px |
| `src/App.tsx` | popup state, translate, paint, download |

The erase is deliberately dumb: a white rectangle over every line box, plus a
white rectangle over every ruby box. It cannot be subtle, but it cannot cover the
wrong area either.

## What has been tried and must not be repeated

Each of these looked reasonable and each one made the result worse.

1. **A colour fill computed from the `seg` mask.** The paper colour came out
   wrong, and where the mask was offset the whole page turned white.
2. **An AOT inpaint model, single 512 pass.** The page turned nearly white,
   because the mask and the page were in different coordinate spaces.
3. **An AOT inpaint model, tiled at 512.** Twelve passes, 33 seconds, and the
   same coordinate confusion.
4. **A refined mask with dilation, per line.** Produced a near empty mask on the
   right hand page because the slice offset was added instead of subtracted.
5. **Splitting a two page scan into pages.** Every offset had to be applied four
   times, in four coordinate spaces, and one of them was always wrong.
6. **Balloon outline as the text container.** The outline is tight, but the
   polygon to rectangle conversion put text over the drawing.
7. **Font size by binary search up to 96 px.** Short lines became headlines.
8. **Writing the result back into the page.** Correct in principle, but it made
   the popup and the page disagree, which hid the real bug for several rounds.

All of it is in the history. The lesson is not "these were bad ideas" but "each
one crossed a coordinate space boundary, and the boundary was written by hand
every time".

## Constraints that are real

- The detector input is fixed at `1 x 3 x 1024 x 1024`. A batch of two fails.
  Large pages are tiled instead, up to sixteen passes.
- `chrome.storage.session` holds 10 MB. Masks are `Float32Array` of 1024 square
  and must never cross a message boundary.
- A cross-origin `<img>` taints a canvas, so the painter fetches the bytes again
  before drawing.
- Models are gitignored. `scripts/prepare-assets.ts` downloads and hash checks
  them: detector 94 MB, recogniser 76 MB, bubble 11 MB, and a charset.

## How to run it

```bash
cd /Users/chingcheonglee/Repos/Javascript/2026-11-04-OCR-Chrome-Plugin-Study
npm run build
```

Reload the extension at `chrome://extensions`, pick an image, press Detect boxes.

The status line is the instrument:

```
25 lines (25 vertical, 0 ruby), 25 read, 9 balloons, 25 grouped, image 1518x1088
```

`Show stages` in the popup shows the erased page and the painted page. Those two
images are the only honest feedback loop this project has. Use them.

## A restart plan that keeps the coordinate problem out

The mistake so far has been to compute things in one space and paint in another.
The next attempt should have exactly one space: the page bitmap.

1. Keep detection exactly as it is. Do not touch `detector.ts`.
2. Erase: white rectangle over each line box. Already done, keep it.
3. Paint into the *line boxes*, not the group boxes, and not the balloons. A line
   box is small and measured by the same detector that found the text, so it
   cannot be far off.
4. One text block per group, but laid out with the group's line boxes as target
   anchors: first line of the translation goes into the first line box, and so
   on. If the translation has fewer lines, centre the rest.
5. Cap the font at the height of a source line box. That is a number the detector
   already produced, so it can never be wrong by an order of magnitude.
6. No balloon outline, no polygon, no clipping, no inpaint model.
7. Only when the result is boring but correct, add ornament: a balloon clip, a
   nicer face, hyphenation, vertical punctuation.

## Acceptance criteria for the restart

1. No white rectangle outside a text box.
2. No text larger than the tallest source line box.
3. Every translated line sits where a source line used to be.
4. The painted page and the popup show the same image, byte for byte.
5. A full pass under ten seconds on a 1500 by 1100 page.

## The article

`app/src/mds/articles/tech/660-build-a-chrome-extension-minimal-mv3-shell.md`
and its `-tc` pair describe steps 1 to 10. They are published, with `wip`
removed. Step 10 currently claims the erase is stroke level with a mask, which is
no longer true. If the renderer is rewritten, step 10 needs a matching edit, in
both languages, and the code fences must stay identical between the two files.

Rules for that article: an anchor on every heading, single line paragraphs, no
bold, no em dash, sentences under 25 words, and the `-tc` file avoids the banned
word list in `app/.claude/skills/translate-article-traditional-chinese`.
