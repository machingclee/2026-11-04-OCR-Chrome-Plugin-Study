# Loop record — the on-device reading as a reference

- **When** 2026-11-18 10:11:19 → 11:05 (Hong Kong time)
- **Where** the block reader (`src/lib/ocr/blockHints.ts`, `src/lib/ocr/cloudOcr.ts`), the incline case (`fixtures/regression.json`), `dist`
- **Rounds** 7; the criterion was one block, the work was finding a column split the recogniser can read
- **Outcome** met: `npm run regression -- incline` 3/3 runs, `npm run regression` 10/10, `npm run typecheck` clean, `dist` rebuilt

## The three questions

**What should change.** BLK 8 (`320,580 73x135`) is three leaned columns and the
reader kept returning two of them: `やっはり` / `熱いな…`, with `ヒーローものは`
missing, so the translation stopped at 果然是熱血啊 and never said 英雄. The
detector drew one blue rectangle over all three columns and the columns are two
pixels apart, so nothing in the pipeline had ever separated them.

**How to verify.** `npm run regression -- incline`, extended in this loop:

- the label in the speech region leans `-16° ±5`, which is counter-clockwise —
  the ink's direction, opposite to the `+5°` the run's diagonal measures;
- at least two labels are drawn there, so a one-column answer still fails;
- the group's translation contains `英雄` and none of `還是誰` / `廣森` / `人類` /
  `一個人的浪漫`, the four readings the earlier loops produced.

The rendered page is `out/regression/incline.png`; the guards are the other nine
cases and `npm run typecheck`.

**Done when.** The speech is three labelled columns leaning with the ink and the
translation carries 英雄, the other nine cases pass, and the check fails on the
pre-fix code. Budget 6 rounds.

## The check, and the baseline

Measured at 11:01 on the pre-fix code with the assertions in place, the case
failed on both halves:

```
"果然摩諾里很熱情啊……" for "やっはりモノリは熱いな…" does not contain "英雄"
"果然" is drawn at 5.5deg, not -16deg (+-5)
"摩諾里" is drawn at 5.5deg, not -16deg (+-5)
"很熱情啊⁠︙" is drawn at 5.5deg, not -16deg (+-5)
```

The pre-fix page is [`assets/onnx-hint-before.png`](assets/onnx-hint-before.png):
three labels, the left column read `モノリ`, every one of them drawn at `+5.5°` —
clockwise, against ink that leans the other way. The fixed page is
[`assets/onnx-hint-after.png`](assets/onnx-hint-after.png): `英雄題材` /
`果然還是` / `很熱血啊……`, all three at `-16°`.

## Rounds

| # | when (Hong Kong) | change | result | what the failure said |
|---|---|---|---|---|
| 1 | 10:24 | measured what the mask knows: the segmentation plane holds the three columns as 1,216 ink pixels, but the detector's box is 25 pixels wider than the ink and its major axis is the diagonal of the run | — | a projection profile cannot split them either: the profile's spread follows the extent, not the gaps, and the valley depth is flat from -20° to +20° |
| 2 | 10:30 | `blockHints.ts`: ink from compact mask blobs only, columns as equal bands of the across axis, the lean found by **trying it** — five leans, the cut the recogniser reads most decisively wins | works | at -16° the three bands read `ヒーローモンは (0.84)` / `熱いな… (0.97)` / `やっぱ (0.76)`; at 0° they read `熱いなーモノは (0.96)` — high confidence, two columns in one band, which is why the cut is scored, not the confidence |
| 3 | 10:36 | the reading goes into the block prompt as a quoted reference | 3 entries came back | `dropReadingsInsideColumns` then dropped `ヒーローモノは`: every entry named the same rectangle, so all three were 78 pixels wide, and the advance test read a six glyph column as a reading of a four glyph one |
| 4 | 10:39 | a reading must be at least 2 pixels narrower than its host before it can be dropped | 3 regions, `-16°` | the labels lean the right way for the first time; the translation is 英雄題材果然還是很熱血啊 |
| 5 | 10:44 | 10/10 suite, `dist` rebuilt | green | one `balloon-split` failure in a full run did not reproduce alone, nor in the two full runs after it: the reader's own variance |
| 5b | 11:00 | ran the tightened case against the pre-fix source, stashed and restored | 4 failures | the check is a real one: it fails on the old code and passes on the new |
| 6 | 10:50 → 11:02 | tried dropping kana-only columns from the quote, then warning about them, then instructing hiragana | kept the quote | without a quoted kana column the reader split ヒーローものは into `ヒイロ` / `モノは`; with the quote it copies `モノ`, and the translator renders ヒーローモノ as 英雄獸 in about one run in three |

## What changed

| area | before | after | why |
|---|---|---|---|
| the block prompt | the crop, the grid and the blue boxes | plus the on-device reading of the same columns, quoted, in reading order | the recogniser is decisive on one upright column; the vision model is decisive on the page |
| the column split | none: the det box is one rectangle over three leaned columns | ink from compact mask blobs, bands across the lean, the lean chosen by the recogniser | no geometric estimator survived: see below |
| the label angle | the run's diagonal, `+5.5°`, drawn clockwise | the block lean the columns were read at, `-16°`, drawn counter-clockwise | the diagonal of three columns is not their direction |
| `dropReadingsInsideColumns` | drops a kana column whose advance is shorter than its host's | only when it is also narrower than the host | with one rectangle for every entry, all widths are equal and the advance is just the glyph count |
| the hint's scope | every block | only a block whose blue boxes are two short of the columns the ink holds | one box short is a detector that split a column; two short is a lost column |

### The estimators that did not work

Worth writing down, because each looked plausible for a round:

- **major axis of the ink** — for three parallel columns the covariance is
  dominated by the column *plus* the offset from one column to the next. On this
  block it returns `+3.7°`; the columns lean `-16°`. This is the sign that drew
  the label the wrong way in the lean-sign loop.
- **k-means / equal bands minimising the across spread** — the spread is
  proportional to the extent, so the minimum follows the lean that makes the
  block *narrowest*, which is not the lean that separates columns.
- **projection profile (Gaussian splat, peakiness or valley depth)** — flat: three
  columns two pixels apart, each 20 pixels wide, do not make a sharp profile. It
  found `0°` for the speech and correctly `0°` / `+18°` for the upright caption and
  the leaned banner, which is why it was tempting.
- **sliding strips scored by the recogniser** — worked (best score at `-18°`) but
  cost 70 recognitions per block, 13 s; the five-lean band cut costs 18.

## The numbers

```
npm run regression -- incline   → pass, 3 runs in a row: source やっぱり / 熱いな… /
                                 ヒーローモノは, labels at -16.0°, translations
                                 英雄題材果然還是很熱血啊……
npm run regression              → 10/10
npm run typecheck               → clean
npm run build                   → dist/ rebuilt at 11:03, the hint sentence is in
                                  dist/assets/offscreen-*.js
```

## What is left over

The speech now reads as three columns, but the reader copies the recogniser's
katakana: the reference says `ヒーローモノは` and the source becomes `モノ` where
the page prints `もの`. The translator renders `ヒーローモノ` as 英雄題材 (the
predicate's 英雄作品) about two runs in three and as 英雄獸 in the third. The case
asserts 英雄, not the phrasing, so it does not flake; the coin is in the
translation, not the reading.

Two levers, in order:

1. **A kana-aware reference.** The recogniser's charset has no hiragana/katakana
   distinction for a long kana run. A mixed-script check — ヒーロー is katakana in
   the image, もの is not — would need the glyphs, not the transcription.
2. **A page glossary** for the translator (`ヒーローモノ` → 英雄作品). Page
   specific, and the loop-04 record already said why that does not generalise.

The bigger win is upstream: the detector draws one rectangle over three columns,
and every downstream pass — the reader, the prompt's blue-box rule, the eraser —
inherits that. A column detector in the detector, rather than in the reader's
reference, would remove the need for this loop's split entirely.
