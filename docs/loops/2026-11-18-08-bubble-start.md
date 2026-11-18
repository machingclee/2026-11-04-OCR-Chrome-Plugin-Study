# Loop record — the shield bubble's two columns start above the glyphs

- **When** 2026-11-18 15:31 → 15:37:32 (Hong Kong time)
- **Where** the regression runner (`scripts/regression.mjs`), the detection payload (`src/offscreen/main.ts`), a new page (`fixtures/page-shield.jpg`) and case (`bubble-start`)
- **Rounds** 0 placement rounds. One measurement of the check, then a stop: the two halves of the agreed predicate cannot both be true of this reading
- **Outcome** not done. The check fails on the current page for the reason in the screenshot. No placement code was changed

## The questions as answered

**What should change.** BLK `483,1168 66×256` on the full page (the two columns `二人はその隙に` / `魔法で攻撃してくれ`) is translated correctly and drawn outside the bubble, from the top. The position must not be taken from a DET box. The block bounds the text.

**How to verify.** `npm run regression -- bubble-start`, through the real detect / translate / paint path. The rendered page is `out/regression/bubble-start.png`. The rest of `npm run regression` is the guard, and it was not run: the loop stopped before a placement change.

**Done when.** Exactly two columns. Each column's label origin within 2 page pixels of that column's character box, on both axes. Both columns' glyphs entirely inside the block. Wording is not asserted. Budget 3, of which 0 were spent on placement.

The attached page is 720×1024, which is the 1126×1600 scan at 0.64. The case stores the block in the fixture's pixels: `309,748 42×164`. The table below is converted back to the full-page pixels the block was named in (`× 1126/720`, `× 1600/1024`).

## The check, and the baseline

```
npm run regression -- bubble-start
```

Measured at 15:37:32. The case is `bubble-start` in `fixtures/regression.json`. It selects the group that overlaps the block, pairs each drawn column with the reader's own page box (`characters`, which is `region.own`, exported on the block reading and not used for placement), and checks the origin and the glyph box. Exit code 1:

```
"你們兩個趁機" starts at 330.6,667.0, 11.6px across and 75.0px along from its character box 319.0,742.0 (limit 2px)
"你們兩個趁機" glyphs at 331,667 20×180 leave the block 309,748,42,164
"用魔法攻擊" starts at 301.0,667.0, 19.0px across and 75.0px along from its character box 282.0,742.0 (limit 2px)
"用魔法攻擊" glyphs at 301,667 25×185 leave the block 309,748,42,164
```

Column count was 2, so that half passed. The crop of the render is [`assets/bubble-start-before.png`](assets/bubble-start-before.png). Regenerate the full page with the command above; the crop is `250,620 180×360` of that PNG.

| | fixture pixels | full-page pixels |
|---|---|---|
| labels, both columns | y 667 | y ≈ 1042 |
| reader box, `二人はその隙に` | 319,742 36×225 | ≈ 499,1159 56×352 |
| reader box, `魔法で攻撃してくれ` | 282,742 36×345 | ≈ 441,1159 56×539 |
| the block | 309,748 42×164 | 483,1168 66×256 |

The label top is the DET box's top: 75 fixture pixels (about 126 full-page pixels) above the reader's box, and above the bubble. The reader's boxes are not inside the block either. The left one starts about 42 full-page pixels left of the block, both start about 9 pixels above it, and both are far taller than the block's 256 pixels. A label that starts on those boxes cannot also lie entirely inside the block.

## Rounds

| # | when (Hong Kong) | change | result | what the failure said |
|---|---|---|---|---|
| — | 15:37:32 | none to placement. The case, the `characters` field, and the `columns` assertion were added so the predicate could fail | exit 1, four lines, quoted above | the labels sit on the DET top; the reader's boxes themselves stick out of the block, so "within 2px of the reader box" and "glyphs inside the block" cannot both pass |

## The numbers

```
npm run regression -- bubble-start   → fail, the four lines quoted above
npm run regression                    → not run
npm run typecheck                     → not run
```

## What changed

The page the user sees is the same page the measurement rendered. Nothing in the typesetter moved.

| area | before | after | why |
|---|---|---|---|
| where the two columns are drawn | label origin y 667 in fixture pixels, about 75px above the reader's box and above the bubble | the same | no placement round was taken |
| what a case can see | the reader's page box (`region.own`) stayed inside the reader and was replaced by the DET frame before anything outside could compare them | the block reading exports that box as `characters`. `bubble-start` compares the drawn origin to it, and the glyph box to the block | the predicate needs both numbers, and the DET frame is the wrong one to compare against |
| the suite | no case for this block | `bubble-start` on `fixtures/page-shield.jpg`, failing with the lines above | a criterion that is not a case will be re-measured as a guess |

What did not change: `blockFrames`, the slot built from `region.frame`, and `frameOf`. The label is still placed on the DET frame. Font size, erase, and the other cases were not touched.

## What was left

The predicate as agreed cannot be met on this reading: the reader's character boxes are not inside the block. Which anchor the next budget uses — the ink inside the block, the reader's box, or the reader's box clamped to the block — was not chosen. The failing case stays in the suite.
