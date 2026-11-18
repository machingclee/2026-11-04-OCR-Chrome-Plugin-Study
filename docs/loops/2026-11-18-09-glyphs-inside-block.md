# Loop record — the shield columns are drawn inside the block

- **When** 2026-11-18 15:55 → 16:08:19 (Hong Kong time)
- **Where** label placement (`src/offscreen/main.ts`, `src/lib/translationJob.ts`), the `bubble-start` case
- **Rounds** 2 of 3
- **Outcome** met: `npm run regression -- bubble-start` passes, and `npm run regression` is 12/12

## The questions as answered

**What should change.** The two columns in the shield bubble were drawn above the balloon. The reader's own box and the block cannot both be the position, because the reader's box sticks out of the block. The painted characters are what has to end inside the block.

**How to verify.** `npm run regression -- bubble-start`. Exactly two columns. The box of the drawn characters of each column lies inside `309,748 42×164` (full page `483,1168 66×256` on this 720×1024 export), with half a pixel of slack. The reader's box is not checked. The wording is not checked. The guard is `npm run regression`.

**Done when.** That command exits 0, and the other eleven cases still pass. Budget 3.

## The check, and the baseline

```
npm run regression -- bubble-start
```

The same glyph assertion failed on the run at 15:37:32, before this placement change:

```
"你們兩個趁機" glyphs at 331,667 20×180 leave the block 309,748,42,164
"用魔法攻擊" glyphs at 301,667 25×185 leave the block 309,748,42,164
```

The detector boxes for those two columns are `299,667 29×211` and `328,667 25×211`. The block is `308.5,747.7 42×163`. The label top was the detector top.

Before is [`assets/bubble-start-before.png`](assets/bubble-start-before.png). After is [`assets/bubble-start-after.png`](assets/bubble-start-after.png), cropped `250,680 180×300` from `out/regression/bubble-start.png`. Regenerate the page with the command above.

## Rounds

| # | when (Hong Kong) | change | result | what the failure said |
|---|---|---|---|---|
| 1 | 15:58 | cut a label back to its block whenever the frame crossed the block edge by half a pixel | `bubble-start` passed, and every column on the page was cut, including ones a pixel over the edge | the threshold was measuring rounding, not the column that starts eighty pixels too high |
| 2 | 16:01, suite finished 16:08:19 | cut only when the frame leaves the block by more than 4px | `bubble-start` passed. The log cut only `二人はその隙に` to `331,748 19×130` and `魔法で攻撃してくれ` to `309,748 17×130`. `npm run regression` 12/12 | — |

## The numbers

```
npm run regression -- bubble-start   → pass (16:01)
npm run regression                    → 12/12, finished 16:08:19
npm run typecheck                     → pass
```

## What changed

| area | before | after | why |
|---|---|---|---|
| the two shield columns | drawn at y=667, the top of the detector boxes, so the characters sat above the balloon | drawn at y=748, inside the block, at 19×130 and 17×130 | the label frame was the detector box, which starts 80px above the block |
| a frame that leaves its block by more than 4px | the whole detector box is the label, including the part outside the block | the label is the part of that box inside the block, and the font is that part's width | the characters are what the check measures, and a frame taller than the block spreads them out of it |
| a frame within 4px of its block | drawn on the detector box | still drawn on the detector box | a one-pixel disagreement between the block edge and the detector edge was cutting every column on the page |

The reading prompt was not changed. The reader's `x, y, width, height` are kept as `region.own` and are not the rectangle the label is drawn on when the answer names a detector box. Changing the prompt would not have moved these two columns.

## What was left

Nothing from the agreed check. The two columns are inside the block. How the translator splits the sentence between them is not part of the check, and it still varies between runs.
