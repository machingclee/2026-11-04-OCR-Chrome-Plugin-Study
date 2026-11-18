# Loop record — the label's font comes from the box, not the reader

- **When** 2026-11-18 11:40:27 → 12:05 (Hong Kong time)
- **Where** the block reader's inclination pass (`src/lib/ocr/cloudOcr.ts`), the
  regression runner (`scripts/regression.mjs`), a new page (`fixtures/page-325.jpg`)
  and case (`font-size`), `dist`
- **Rounds** 3; the criterion was one block, the fix a formula
- **Outcome** met: `npm run regression -- font-size` green, `npm run regression`
  11/11, `npm run typecheck` clean, `dist` rebuilt

## The three questions

**What should change.** BLK `937,139 59x263` is the cup speech: two upright
columns of 27 pixel glyphs, `私が直接` / `指導させてもらいます`. The translation was
drawn in two columns — the layout was right — but at about 13 pixels, a third of
the source, so it floated in a balloon it should have filled. The size the label
gets is `em`, and `em` came from what the reader answered on the grid.

**How to verify.** A new case, `font-size`, on `fixtures/page-325.jpg`:

- the cup speech's two labels are within ±30% of 27px, the column width the
  detector boxed (29–30px);
- the same rule on two other blocks of the page, so the fix is a measurement and
  not a number for one balloon: `2カ月後の試験で` at 30px and
  `訓練校を退学してもらいます` at 42px;
- `fontSizeSelfTest()`, which builds a 29px box with a reader `em` of 13 and of
  44 and checks the glyph is 29px both times — the half of the case that needs no
  network and so cannot flake.

**Done when.** The three blocks are within ±30% of their column, the self-test
shows the reader's `em` cannot set the size, and the other ten cases pass.
Budget 3 rounds.

## The baseline, and how the number went wrong

The reader is asked for `em` on every entry, "the size of one character in page
pixels, measured from the grid". On this column it answered **44** in one run and
**13** in another. The pipeline then did, for a box holding one column:

```ts
const em = Math.max(reportedEm ?? 0, (inkEm ?? 0) * 0.6) || band;
const thickness = Math.max(4, Math.min(em, band * 0.95));
```

so a 44 became 28 (the box capped it) and a 13 stayed 13: the reader's number is
a floor. Three other things made the floor hard to notice:

- when the segmentation plane could not measure a lean for the box, the whole
  em path was skipped — `continue` before `em` was computed — so the reader's
  `em` survived untouched;
- the plateau's ink is faint, so the plane's interquartile width came back 11.7
  on a 30 pixel column, which is a plane that missed the column, not a glyph;
- `fitColumns` only shrinks, so nothing downstream can put a size back.

The report is [`assets/font-before.png`](assets/font-before.png): two columns,
correct text, a third of the size. The same block after the fix is
[`assets/font-after-zoom.png`](assets/font-after-zoom.png), and
[`assets/font-after.png`](assets/font-after.png) is the panel at 1:1.

## Rounds

| # | when (Hong Kong) | change | result | what the failure said |
|---|---|---|---|---|
| 1 | 11:44 | added the page, reproduced the read: the reader answered `em 44` on both columns and the ink measured 47, so the label came out 28 — right by luck | — | the size is a max of two guesses; a different draw of `em` is a different page |
| 2 | 11:48 | `em` from geometry only: the box width divided by the columns found in it, and the ink's interquartile width as the cap | 28.6 / 28.7px | but the box whose ink the plane cannot measure skipped the whole branch and kept the reader's 44 |
| 3 | 11:52 | the size is computed before the lean bail-out, so a box with no measurable lean still gets a measured glyph; the ink is only believed above 60% of the box | `font-size` 27 / 30 / 38px, self-test 13→29 | a 12px ink reading on a 30px box is the plane missing, not a 12px glyph |

## What changed

| area | before | after | why |
|---|---|---|---|
| the glyph's size | `max(reader em, 0.6 × ink)` capped by the band | the box's own column width, capped by the ink when the ink is credible | the reader's `em` was 44 and 13 on the same column; the box is 29–30 every run |
| a box with no measurable lean | the branch bailed out before the size was computed, leaving the reader's number | the size is computed first; only the angle is dropped | no lean is not no size |
| the ink's IQR | always used, at 0.6 | used only when it is at least 60% of the column | a faint column reads 11.7px on a 30px box |

## The numbers

```
npm run regression -- font-size   → pass: 私が直接 27px, 2カ月後の試験で 30px,
                                    訓練校を退学してもらいます 38px (em 42, −10%)
npm run regression                → 11/11
npm run typecheck                 → clean
npm run build                     → dist/ rebuilt
```

## What was deliberately not changed

- **The reader's `em` is still asked for and still logged.** It is evidence about
  the crop the reader saw and it is useful in the debug view; it is just not the
  measurement the label is drawn from.
- **The translation prompt.** The size was never the translator's job.
- **`fitColumns`.** It shrinks a long translation into its column, and it does so
  from a glyph size that is now right; changing both at once would hide which one
  moved the label.

## What is left over

The ink's interquartile width over-reads a *leaned* column: on the 卒業証書 banner
the box is 169 wide and the plane's IQR 112, so the banner's label was sized from
the box rather than from its 60 pixel glyph. The incline case asserted only the
banner's angle, so nothing failed. The next loop took it — the glyph is the tight
rectangle inside the box, `W·cos θ − H·sin θ` — see
[the banner loop](2026-11-18-07-banner-tight.md).
