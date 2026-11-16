---
title: "Text Detection: ShinobuTranslator Comparison And Pipeline Rewrite"
date: 2026-11-16
intro: "How this extension found text lines, what ShinobuTranslator does differently, and what the rewrite measured."
---

### Overview {#overview}

The extension detects text lines with one ONNX model that returns a line map and a stroke map. The old code spent 1734 lines turning those two maps into boxes. The boxes were usable, but they came with a long tail of false ones. Every repair pass added boxes over artwork, and those boxes reached the recogniser and the translator.

This note compares that code with the detector in ShinobuTranslator, records what the model emits, and describes the replacement pipeline with its measured results.

### How The Two Projects Detect Text {#how-the-two-projects-detect-text}

#### The Extension Before The Change {#the-extension-before-the-change}

The old pipeline read channel 0 of the `det` output as one seed per text line. For each seed it walked the `seg` map at glyph level, grouped strokes into columns, split a seed where a projection valley suggested two columns, snapped near-vertical text onto the page axis, grew a box along the `det` map, and cut the box at balloon edges. A second box source merged `seg` clusters directly, with no score gate.

The offscreen document then ran five more repairs: grow to ink, clip at bubbles, restore the cut ends, split parallel lines, and fit every box to paint.

Each step was a local repair for a failure seen on one page. Each step could move a box onto its neighbour, so a later step repaired those moves too. No single place decided what a line is.

#### ShinobuTranslator {#shinobutranslator}

ShinobuTranslator reads the same two maps with a much shorter rule. It thresholds `det` at 0.3, takes eight connected components, fits a minimum area rectangle to each component boundary, rejects a component whose mean score is at most 0.6, widens the rectangle by `area * 1.5 / perimeter`, and fits a rectangle again. Each rectangle becomes a quad with a direction. That is the whole line extraction, in one function of about 70 lines.

Two later stages carry the rest. `mergeTextLines` groups quads into text blocks with the merge predicates from manga-image-translator. `filterOcrRegions` re-reads doubtful regions at three scales and drops a region when the readings disagree and the mask looks unlike text. The bubble model only matches regions to balloons, and never moves a box.

#### Where The Two Agreed And Differed {#where-the-two-agreed-and-differed}

| Stage | Extension, before | ShinobuTranslator |
| --- | --- | --- |
| Seed source | `det` channel 0 at 0.25 | `det` channel 0 at 0.3 |
| Seed shape | component pixels, hull, upright snapping | component boundary, minimum area rectangle |
| Widening | unclip, then stroke alignment, then growth walks | one unclip of 1.5 |
| Column split | projection valley, balloon edge, stroke clusters | none in detection, handled by the merge stage |
| Second source | merged `seg` clusters, no score gate | none |
| Balloon use | clips and stops boxes | matches boxes to balloons for typesetting only |
| Repair passes | five, in the offscreen document | one OCR filter stage after OCR |

### What The Detector Actually Emits {#what-the-detector-actually-emits}

#### The Det Plane Holds One Narrow Band Per Line {#the-det-plane-holds-one-narrow-band-per-line}

On a 720 by 1024 manga page the `det` plane at threshold 0.3 produced 15 components. Thirteen cleared the 0.6 mean score. Each component is a band about 12 to 19 pixels wide inside a text column that is about 25 to 35 pixels wide. The band is also sometimes short: the `坊ちゃん` column runs 130 pixels down the page, and its band covers 43 pixels.

The band is the DBNet shrunken response. The model does not answer with the full line, so every consumer has to widen it again.

#### The Seg Plane Holds Every Stroke {#the-seg-plane-holds-every-stroke}

On the same page the `seg` plane at threshold 0.46 produced 106 components. They cover every glyph of every column, including the columns where the `det` band stops short. They also cover artwork: screen tone edges, panel borders, and the streaks of concentration lines.

The two planes therefore carry different information. `det` says which pixels belong to a line and is precise but incomplete. `seg` says where ink is and is complete but has no notion of a line.

#### What That Means For Postprocessing {#what-that-means-for-postprocessing}

A pipeline that trusts `det` alone loses the tail of a column and misses stylised lettering. A pipeline that trusts `seg` alone reads artwork as text. The useful design keeps `det` as the seed and uses `seg` as the extent of that seed, which is a small amount of work.

The old pipeline did that, but it also moved seeds for reasons unrelated to extent, and it admitted `seg` clusters that no line seed could justify.

### Why The Old Pipeline Produced False Boxes {#why-the-old-pipeline-produced-false-boxes}

#### A Seed That Stops Short {#a-seed-that-stops-short}

The `坊ちゃん` column has a `det` band of 43 pixels. At seed level the old box stopped at 55 pixels, short of most glyphs. The later grow-to-ink pass walked `seg` ink down the column and recovered the line, so OCR read `坊ちゃん` correctly. The same pass also walked over artwork whenever `seg` marked ink near a seed, which is one source of the false boxes.

The repair worked, but it worked by chasing ink rather than by knowing the column. That is why it could cross into the next line.

#### A Second Source Without A Score Gate {#a-second-source-without-a-score-gate}

The `seg` second source merged stroke clusters up to 5 pixels apart and applied only an aspect ratio filter. On page 6 the pipeline produced 28 boxes and 32 lines after splitting, and 8 of those readings came back empty. They sat on screen tone, concentration lines, and panel borders.

#### Rows Of Horizontal Text {#rows-of-horizontal-text}

`mergeAligned` joined two boxes stacked in the same column when the vertical gap was below half the box width. For a vertical column the width is the thickness, so the rule was sound. For a horizontal line the width is the whole line, so the rule joined adjacent rows. On a synthetic page with three horizontal lines, the three boxes merged into one.

The old pipeline hid this bug, because `splitParallelLines` cut the merged box again at the `det` gap. The new pipeline has no such splitter, so the rule had to be corrected before it could be used.

### The New Pipeline {#the-new-pipeline}

The replacement lives in `src/lib/detect/` and has three files. `inference.ts` owns the session and the letterbox. `lines.ts` owns extraction and is free of DOM calls. `index.ts` joins them and returns the same `DetectionResult` as before.

#### Line Seeds From The Det Head {#line-seeds-from-the-det-head}

The seed path follows ShinobuTranslator. Threshold `det` at 0.3, take eight connected components inside the image area, fit a minimum area rectangle to the boundary pixels of each component, reject a component with a mean score at or below 0.6, and widen the rectangle by `area * 1.5 / perimeter`. Map the result to page pixels.

A rectangle within 20 degrees of a page axis is stored as an axis aligned box. A larger lean keeps the angle and the length and thickness along it, which is what a tilted sound effect needs. This replaces the old hull fit, the upright snapping, and the projection splitter.

A box that ends up covering two columns is cut again from the `det` profile. That cut is described in [When One Box Covers Two Columns](#when-one-box-covers-two-columns), with the page that needed it.

#### Glyph Strokes From The Seg Head {#glyph-strokes-from-the-seg-head}

Threshold `seg` at 0.46 and take eight connected components. Keep a component with at least 12 pixels, a side of at least 3 pixels, and a long side below 45 percent of the page short side. Each one becomes a stroke with a page rectangle and a centre.

#### Growing A Seed To Its Own Column {#growing-a-seed-to-its-own-column}

A seed first absorbs the strokes whose centres fall inside its rectangle. Then it grows one stroke at a time. A stroke joins when three conditions hold. It overlaps the box across the text direction by at least 35 percent of the smaller width. Its width across the text direction is between 0.2 and 2.2 times the box thickness. Its gap along the text direction is at most 1.1 times the thickness.

The across overlap condition is the one that keeps two columns apart. Two columns in one balloon are 5 to 10 pixels apart and have no overlap, so a stroke from the neighbour never joins. The along gap condition is what recovers a truncated column: glyph gaps inside a column are smaller than one thickness, and the break between one speech and the next is larger.

The box is the union of the seed and its strokes, padded by one pixel. No hull fit follows, so the box stays a page rectangle.

#### Lines The Det Head Missed {#lines-the-det-head-missed}

Strokes that no seed reached are grouped into candidate lines. The grouping links two strokes when they share their band across a column and their vertical gap is below 0.9 times the smaller width, with a size ratio below four. A second pass links single strokes into a row, but only when neither stroke already belongs to a column, so two vertical columns never become one horizontal line.

A candidate is kept only when it has at least two strokes, its short side is within 0.35 to 4 times the page median, and it passes two gates. Inside a balloon it needs only the strokes. Outside a balloon it must be at least 1.8 times longer than it is thick, and it needs a mean `det` response of at least 0.12.

The two-stroke rule removes single panel borders and highlight strokes. The elongation rule stops two strokes of one large sound effect glyph from becoming a line. The balloon and `det` rule keeps stylised lettering that the `det` head skips, without turning dark artwork into dialogue.

#### Filters And Deduplication {#filters-and-deduplication}

Boxes are ranked by area. A box that overlaps a larger kept box by more than half its own area is dropped, and a box with almost no `det` or `seg` response is dropped. This replaces the old overlap suppressor and the paint check that ran in the offscreen document.

The offscreen document now runs detection, reading order, grouping, one paint filter, and OCR. The five repair passes are gone, together with `expand.ts` and `trimRuby.ts`.

### Measured Results {#measured-results}

#### The Test Method {#the-test-method}

Each page runs a headless harness: the bubble model, detection, `toOrderedTextLines`, `groupByRegion`, the paint filter, and `recognizeLine` on every surviving box. The harness uses the same ONNX files as the extension and the WASM provider. It runs both pipelines against the current reading order and OCR code, so the comparison isolates detection.

A reading is usable when its confidence is at least 0.7 and its text is not empty. A reading is strong when its confidence is at least 0.9.

#### Page 6 {#page-6}

The page has 13 dialogue columns, one stylised `やだっ`, and several sound effects. The bubble model returns 7 regions.

| Measure | Before | After |
| --- | --- | --- |
| Boxes | 28 | 13 |
| Lines sent to OCR | 32 | 13 |
| Empty readings | 8 | 0 |
| Usable readings | 14 | 13 |
| Strong readings | 12 | 12 |
| Mean confidence | 0.571 | 0.990 |
| Characters read | 78 | 61 |
| Characters at strong confidence | 59 | 59 |

Both pipelines read the same 13 dialogue columns at the same strength, including `坊ちゃん` and `なさいませ！`. The before column carries 19 extra readings. Eight are empty and 11 are fragments of artwork or sound effects. Those readings cost OCR time and 17 characters of junk.

Both pipelines miss `やだっ`, which the `det` head never marks and which sits outside every balloon.

#### Page 2 {#page-2}

The page has 35 dialogue columns and one sound effect. The bubble model returns 10 regions.

| Measure | Before | After |
| --- | --- | --- |
| Boxes | 47 | 35 |
| Lines sent to OCR | 45 | 35 |
| Empty readings | 2 | 0 |
| Usable readings | 38 | 35 |
| Strong readings | 36 | 34 |
| Mean confidence | 0.869 | 0.996 |
| Characters read | 172 | 162 |
| Characters at strong confidence | 163 | 158 |

Both pipelines read all 35 dialogue columns. The before column has 10 extra readings and 10 characters of junk, and three of those readings cleared the confidence floor. The after column has no box that is not a dialogue line.

#### A Synthetic Page {#a-synthetic-page}

A generated page has three horizontal lines, two vertical columns, and one large sound effect. The before pipeline produced 7 boxes, including two low confidence fragments of the sound effect. The after pipeline produced 5 boxes, read all three horizontal lines and both columns at 0.99 or better, and produced no fragment.

The three horizontal lines also exercise the row stacking fix. Without the fix the three boxes merge into one, and OCR returns one and a half rows.

#### Reading The Numbers {#reading-the-numbers}

Dialogue recall is equal on the two manga pages. The gain is precision and cost. Boxes fall from 28 to 13 on page 6 and from 47 to 35 on page 2, and no box is left without text. Mean confidence rises because every reading in the after column is a real line.

The code falls from 2293 lines in three modules to 809 lines in three modules, and one growth rule replaces five repair passes.

### When One Box Covers Two Columns {#when-one-box-covers-two-columns}

#### The Page {#the-page}

A 1125 by 1600 page carries white narration lettering over a dark galaxy texture and has no balloons at all. The bubble model returns nothing, so every box on the page comes from a `det` seed.

#### The Cause {#the-cause}

The `det` plane did its job: it returned two clean bands, 19 and 22 pixels wide, one per column. The `seg` plane did not. The glow around the lettering merged `人類のような` and `知的文明が存在する確率` into one stroke component 86 pixels wide, while a single glyph is about 40 pixels. The seed for the left column took that component as a member, the box covered both columns, and the recogniser read them as one line. Its confidence fell to 0.33 and the line was dropped.

The lesson is that a stroke is a weak authority on the width of a line. It is a good authority on the length, because ink runs down the column, and a bad authority on the width, because noise can bridge two columns.

#### The Cut {#the-cut}

`splitAcrossDetGaps` reads the `det` plane again, after the box exists. It builds a profile of the strongest `det` response down the thin axis, so only a strip that is empty along the whole length of the box can appear. An interior empty run of at least 3 pixels below 15 percent of the profile peak is a column break, and the middle of that run is the cut.

A piece narrower than 30 percent of the box cancels the cut, so the pass cannot trade one box for two slivers. The length of the box is unchanged: a short column in one piece carries some empty paper in its crop, which costs nothing in recognition.

#### The Result {#the-result}

| Measure | Before the cut | After the cut |
| --- | --- | --- |
| Boxes | 10 | 11 |
| Usable readings | 9 | 11 |
| Mean confidence | 0.865 | 0.930 |
| `人類のような` | part of a two-column box at 0.33 | 0.92 |
| `知的文明が存在する確率` | part of the same box | 1.00 |

The cut also leaves the two other pages and the synthetic page unchanged, because their boxes have no interior empty strip in the `det` profile.

PP-OCR read these white-on-dark crops about as well as inverted copies, within 0.04 of confidence either way, so the OCR preprocessor keeps no tone flip. The reading failures on the page came from the box, not from the polarity.

### The Block Path {#the-block-path}

The detector ships a third head besides `det` and `seg`: `blk`, a region head that answers with one box per text block, such as a whole balloon, a caption or a group of columns. The block path makes that head the unit of detection.

#### How A Page Is Read {#how-a-page-is-read}

1. The detector returns the block boxes, the `det` plane and the `seg` plane. Blocks are filtered at score 0.35, non maximum suppressed at 0.35 and capped at 96. The det line extraction is skipped entirely, so no det box takes part in detection.
2. One crop per block is cut, upscaled, and given a grid before it goes to the reader, at 96 pixels on the short side, six requests in flight.
3. The model answers with the regions inside that block, in cells of the drawn grid:

```json
{"regions":[{"text":"…","type":"chat","direction":"v","x":12,"y":2,"width":5,"height":28}]}
```

Reading is perception and stops there: it transcribes the text and places it, and never translates. The reader runs at no thinking at all, because a chain of thought over glyphs only adds latency to every block.

The crop also carries the detector's line boxes, drawn in blue, and the prompt makes them the definition of text: **only what sits inside a blue rectangle is a line**, and everything outside every rectangle is artwork or handwriting that must not be reported, translated or allowed to widen a box. The det head is not a box source in this path — the crop is still the BLK box — but its line boxes are the reader's evidence of what the page intends as text, which a model cannot otherwise tell from a hand drawn formula in the same panel.

Furigana stays out of the text. The prompt names the reading kana printed beside kanji, forbids merging them into `text`, and skips a region that holds only furigana. A reader still reports one now and then, and a reported reading is a line with its own translation, which is how one sentence came back as two identical columns. So the mapper drops any short kana entry whose box sits inside a wider column's own band: that is what a reading looks like, and a real line never shares another line's band. A short kana column *beside* a box is a different case and is still folded into its neighbour.

Handwriting is excluded for the same reason and a costlier one. A page can have a printed column and a hand drawn formula side by side, and a reader that reads the formula as part of the column returns a box that covers both: the label then sits off the column, the erase covers paper that held no text, and the translation carries digits that were never dialogue. The prompt calls hand drawn marks artwork, keeps them out of `text` and out of the box, and says a printed column keeps its own width. Small kana that belong to a word, such as the `っ` in `いって`, stay. A `ruby` field can carry the reading for inspection, but nothing downstream reads it.

There is one entry per text line, never one entry for two columns. `x` and `y` are the cell holding the line's top left corner, `width` and `height` its size in cells. Every one of them is a whole cell, so a box always starts and ends on a grid line; the parser rounds anything else to the nearer line.

#### The Drawn Grid {#the-drawn-grid}

The crop carries a grid when the model sees it. Every line is numbered: the numbers along the top edge are blue and count x, the ones along the left edge are red and count y, and every fifth line is drawn thicker. One cell is about a twentieth of the crop's long side, which is coarse enough that the lines do not bury the kanji and fine enough to place a character; four pixel cells were drawn first and the grid crowded out the text.

Numbering every line rather than every fifth is what the reader needed. With numbers only at 0 and 5 on the top edge it interpolated badly and answered x 12 on a grid nine columns wide, borrowing the 0 to 20 scale it could see on the left edge; the parser slid that box back to the last column, so the page was right while the answer was not.

The point of drawing it is that a box stops being a measurement. A fraction of the crop is a number the model invents, and its fractions were wrong often enough that a line landed beside its column. A cell is a line the model can see and a number printed on the image, so the answer is a reading, and the mapping back is one multiplication:

```
left   = crop.x + x * cell
top    = crop.y + y * cell
width  = width * cell
height = height * cell
```

`cell` is computed from the crop alone, so the same value the grid was drawn with is the value the answer is mapped with. A box read past the edge of the crop is pulled back inside it.

A region that claims to hold two columns of text (`columns` 2) is still cut in two, right to left, because the reader sometimes merges a pair of short columns into one entry.

An answer that still speaks in fractions is accepted, and a leaned line needs them: a grid cannot describe a lean, so `direction: "i"` keeps `left`, `top`, `width` and `height` alongside `angle`. The box the model reports is axis aligned, so the length along the text is the projecting side divided by the cosine or sine of the lean, and the em is that length divided by the character count. The line is stored as a rotated rectangle, with the text direction taken from the angle: above 45 degrees the text reads vertically.

#### Where The Font Comes From {#where-the-font-comes-from}

The font is the grid, not a second measurement: the reader says how many cells the character covers and the cell size is known, so the em is that count times the cell. Two cells of a nine pixel grid are an eighteen pixel character, and the label is laid out in the box the reader gave, which is why a translation fills the space the original filled instead of a guessed one.

An answer in fractions has no cell count, so it falls back to the side across its box, and an inclined line falls back to its own text: the length along the lean divided by the character count. Only a piece cut out of a merged entry loses its cell box, because the entry described several columns and the piece is one of them.

When a translation is shorter than the box it fills, the spare room goes into the gaps between the characters, so the label covers the box instead of bunching at its top. The spacing is in em, so it follows the font when the fit shrinks the label.

4. Each region becomes a line box with its text and its direction, and each block becomes one group. The reading order inside a block is right to left for vertical text and top to bottom for horizontal text.

#### The Translation Pass {#the-translation-pass}

Translation is a second pass, one request per block, after the reading has finished. The block's lines go out as the structured payload the target project uses: plain text, text with its visual breaks, reading order, and one entry per column with its character count, so the model knows how much room each column must fill. The rest of the page travels with the request as context — listed and explicitly not translated — so a request about one block still knows what the conversation around it said.

The pass runs at the effort the popup stores, high by default, which is where a chain of thought pays: the reading is a transcription, while the translation has to reorder clauses, pick a register and split the result back into columns. Four requests are in flight at once.

The answer is written back into the block it came from (`group.translations`), so the block carries the translation it produced, the layout uses it directly, and a second run does not translate the same block twice.

#### What Inpainting Uses {#what-inpainting-uses}

The block path builds the erase mask from the `det` plane, not from `seg`. The region boxes say where to erase; the det bands inside them say which pixels belong to the strip. `refineMask` then grows every band by about a fifth of the line thickness, which covers the soft edge of the glyphs.

A box whose centre falls inside a balloon never reaches the generative model. The inside of a balloon is one flat colour, so the pass fills and stops, with the tone sampled from the balloon's own paper, or plain white when there is no sample. A model asked to invent a balloon interior is what once returned a black one, and it is also slower than a fill.

Two conditions decide a fill, and no third one. The box is inside a balloon, and the fill stays inside the box. The balloon outline is deliberately not used as a clip: the seg polygon is coarse, and a fill that stopped at its edge left the bottom of a column on the page — the top of the balloon was cleaned and the last few kana stayed. The line boxes are already tight and already inside the balloon, so a rectangle filled to its own edges covers the text completely. The mask path, for boxes whose paper is unknown, fills only where the seg plane found ink, grown by `refineMask`, which is the same two conditions with the ink as the second one.

The detector's line boxes — the blue rectangles drawn on the reader's crop — are filled whole rather than masked. A masked fill only replaces the pixels the det plane calls ink, so a soft glyph edge survives as a grey rim, and the reader's own box can sit a cell off the row. A line box is tight around its text, so filling its rectangle leaves nothing behind.

The colour of that fill is read from the ring of paper just outside the box, not from the whole balloon: the median of a band a few pixels wide, clipped to the balloon outline. A balloon can sit over screentone, carry a gradient, or have its median dragged by its own ink, and the ring is exactly the paper the glyphs were printed on. The balloon's median is the fallback when the ring has nothing to read.

This is the main trade of the path. `seg` marks actual ink and keeps the erase tight; `det` is a shrunken band, so the mask leans on the growth step. On flat balloon paper the fill hides the difference. Over artwork the mask is less precise than the stroke mask, and a ghost edge is the failure to watch for.

#### When The Path Is Used {#when-the-path-is-used}

The block path runs when a cloud reader is configured and at least one block carries regions. A block the reader answers with no regions contributes no lines; the rest of the page is unaffected. Without a key, or when every block comes back empty, detection falls back to the line path: the `det` seeds, the stroke split, the on device recogniser. The popup status reports the reader and the number of regions it placed, so a page that silently used the line path is visible.

The det plane is never a box source in the block path. It is read once, as the erase mask, and for nothing else. The seg plane is read for the balloon paper colour and the label masks. The line path, which runs only when no reader is configured, is the one place the det head still proposes boxes.

#### What Was Kept {#what-was-kept}

The stroke plane is still used for two things the block path does not replace: painting the paper colour of a balloon, and cutting the label masks from the glyph pixels. The balloon model still matches blocks to balloons so a fill can be flat instead of inpainted.

### OCR Normalisation That Did Not Help {#ocr-normalisation-that-did-not-help}

A clean crop can still come back with the wrong character. On the narration page the last glyph of `宇宙人に` is a `に`, and the recogniser reads it as `に` at 0.82. A crop three pixels wider reads `宇宙人だ` at 0.76. The character boundary is that narrow, so a normalisation step was measured before any of it was added.

Eleven variants ran on the same crop: raw, 2x upscale, 12 percent white margin, Otsu binarisation, percentile contrast stretch, unsharp mask, 3x3 median, and four combinations of those.

| Variant | Confidence | Text |
| --- | --- | --- |
| raw | 0.875 | 宇宙人に |
| 2x upscale | 0.866 | 宇宙人に |
| 12 percent margin | 0.666 | 宇宙人に |
| Otsu | 0.959 | 宇宙人に |
| 2x upscale and Otsu | 0.973 | 宇宙人に |
| unsharp | 0.897 | 宇宙人に |
| 3x3 median | 0.940 | 宇宙人に |

Every variant keeps the same characters. The normalisation raises confidence, and confidence is not the problem: the model already reads this crop correctly. On a crop three pixels wider, Otsu returns `宇宙人` at 0.874 and drops the glyph.

Otsu was also measured across 59 lines on three pages. Five readings changed: three became worse (`パ` to `バ`, a lost dakuten; `えー` to `え1`; `ゃべ…っ` to `ゃ…`), one fixed a fullwidth `１`, and one replaced `人` with `入`. A hard threshold removes the soft edge of a stroke, which is exactly where a dakuten lives. The preprocessor therefore keeps the raw crop.

The same test rules out a test-time ensemble that keeps the most confident reading, because a fluent wrong reading can score higher than a correct one. The levers that remain are the box and the recogniser, not the pixels.

### Cloud Reading {#cloud-reading}

#### What Moves And What Stays {#what-moves-and-what-stays}

DeepSeek is the only provider. Its key both reads the blocks and translates the page; there is no provider setting and no second key. Without a key nothing runs: the popup reports that a key is needed, and the page's Translate selected action stays disabled. The service worker resolves the reader from the saved key, so the popup button, the page translation and the batch flow all read the same way.

Every line is read on the device first. Only a line whose device reading is empty or below 0.7 confidence is sent to the cloud, one upright crop per request. A confident device reading is never replaced, because a general vision model misreads printed manga more often than the recogniser trained for it: on the test pages the device read 13 of 13 and 35 of 35 lines correctly, and the cloud reader returned other text for the same crops.

The crop keeps the orientation it has on the page. The device recogniser wants a vertical column turned a quarter turn, but a general model reads vertical Japanese as printed, and the turn rotates every glyph, which is exactly what a misread looks like.

#### The Crop And The Request {#the-crop-and-the-request}

Each crop is scaled so its thin side is about 64 pixels, upscaled at most 3 times and capped at 1600 pixels on the long side. It travels as a JPEG at quality 0.92, one crop per request, six requests in flight, and the model answers with one entry:

```json
{"lines":[{"i":1,"text":"久しぶりの"}]}
```

The prompt asks for the printed glyphs only. It names small kana, dakuten, punctuation, and full-width characters, and it forbids translation, spaces, and completion from context. One crop per request means the answer can only describe that line: there is no index to map, and no way for a model to pair a transcription with a different crop. A request that fails is retried once, then that line is read on device.

#### One Crop, Several Text Lines {#one-crop-several-text-lines}

The model reports the layout of each crop as well as the text:

```json
{"lines":[{"row":1,"columns":1,"text":"人類のような"},{"row":2,"columns":1,"text":"知的文明が存在する確率"}]}
```

`row` is the position of the text line inside the crop, top to bottom, and `columns` is how many parallel character columns that line itself holds, which is 1 for a normal line. The array length is the number of text lines the crop contains.

That array is how a detection box that swallowed two columns is repaired at reading time. A vertical column is turned a quarter turn before it is sent, so the source columns arrive stacked top to bottom and the first entry is the rightmost source column. When the model returns two entries, the offscreen document cuts the box into two pieces across its thin side, in reading order for the page direction, and gives each piece its own text. The translation then typesets each piece into its own column, so the placement follows the text instead of squeezing two columns into one box.

The cut is bounded: a piece narrower than 12 pixels is refused, more than four pieces is refused, and a leaned line is never cut because its page box is not the box the text is drawn from. When any bound is hit, the line keeps a single reading.

#### Choosing The Model {#choosing-the-model}

The reader calls `deepseek-flash` and never thinks: its request carries `thinking: disabled`, whatever the popup holds, because reading glyphs is perception and the layout that goes with it is arithmetic on the grid. The translation call is the one that gets a chain of thought, at the level the popup stores: the API maps every level onto low, high or max and thinks at high by default, so those three are offered, plus off. High is the default for translation.

The setting governs the whole page: the per-block reading calls, the one fallback translation call for regions the reader left untranslated, and a batch. It is stored in the browser with the API key and sent with each request, so a run started from the content script reads the same level as one started from the popup.

#### Falling Back {#falling-back}

Three levels of fallback keep a page usable:

1. A line the model leaves blank is read by the on-device recogniser.
2. A batch that fails, by network error, quota or a malformed answer, is read entirely on device.
3. A crop that cannot be cut at all falls back to the on-device path for the page.

The popup status line reports the reader and the fallback count, so a page that silently ran on device is visible.

#### Cost And Privacy {#cost-and-privacy}

One page costs a request per block for the reading and one request for the translation. `deepseek-flash` caps every image at 1024 tokens, so a page of seven blocks stays in the fractions of a cent ([vision guide](https://api-docs.deepseek.com/guides/vision/), [pricing](https://api-docs.deepseek.com/quick_start/pricing)).

Reading uploads the block crops and translation uploads the page text to DeepSeek. That is the only provider, so there is no on-device alternative to fall back to: without a key the extension does not translate at all.

#### What The Cloud Never Does {#what-the-cloud-never-does}

The cloud reader never returns a box, and its answer is never used to place text. It has no say over reading order or grouping either. A cloud answer can only replace the characters inside a box the detector already produced, which keeps the layout identical to the on-device result.

### Remaining Limits {#remaining-limits}

Stylised handwriting still costs recognition confidence: two columns on the narration page read at 0.76 and 0.82. Both stay above the 0.7 floor, and the cause is the recogniser, not the box.

A line that the `det` head misses, that sits outside every balloon, and that has one glyph is not detected. A large sound effect outside a balloon is detected only when the `det` head marks it. The harness runs on the WASM provider, so the WebGPU path is exercised only by the build.

The model is the limiting factor for stylised lettering. A different detector export, such as the `detector.ort` asset in ShinobuTranslator, may mark those lines. The pipeline would accept it without a change, because the seed rule only depends on one line band per column.

### Reproducing The Measurement {#reproducing-the-measurement}

The harness is a local script, not part of the build. It needs a canvas implementation, and this workspace uses the one in the ShinobuTranslator checkout. The steps are:

```bash
# bundle the harness with the page sources, then run it on one image
cd .tmp-expcheck/compare
../../node_modules/.bin/esbuild eval.mjs --bundle --platform=node --format=esm \
  --outfile=eval.bundle.mjs --external:onnxruntime-web
node eval.bundle.mjs /tmp/dbg2/page6.png
```

The script prints each reading with its box, its confidence, and its text, followed by a summary line. `eval-legacy.mjs` does the same for the pipeline before the rewrite, which keeps the two summaries comparable. The same scripts render the boxes to PNG through `renderBoxes` for a visual check.
