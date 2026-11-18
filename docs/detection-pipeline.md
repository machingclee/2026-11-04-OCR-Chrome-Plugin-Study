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
2. One crop per block is cut, upscaled to 440 pixels on the short side, and given a grid and a numbered blue rectangle per detected line before it goes to the reader, six requests in flight. The crop is the BLK box with a margin, grown as far as it must be to hold every detector box drawn on it: a box cut by the crop edge is one the reader tends to skip, and the column it held is then translated nowhere. The crop the reader is shown is the erase box plus a ruler strip on the top and the left; the erase area is computed from the box alone, so growing it for the numbers does not change what is erased. The debug panel prints the rectangle that was cut, in page pixels, beside the BLK box and draws it on the preview as a dashed violet outline.
3. The model answers with the regions inside that block, naming the rectangle that holds each one:

```json
{"regions":[{"text":"…","type":"chat","direction":"v","box":2,"x":1035,"y":133,"width":28,"height":89}]}
```

Reading is perception and stops there: it transcribes the text and places it, and never translates. The reader runs at no thinking at all, because a chain of thought over glyphs only adds latency to every block.

The crop also carries the detector's line boxes, drawn in blue and numbered in green above their top left corner, and the prompt makes them the definition of text: **only what sits inside a blue rectangle is a line**, and everything outside every rectangle is artwork or handwriting that must not be reported, translated or allowed to widen a box. Numbering them is what stopped the drift: a model asked *where* a line sits measures it badly — 20 page pixels out at best, a whole column at worst — while naming *which* rectangle a line is in is a choice, and the rectangle is already the ink. The det head is not a box source in this path — the crop is the BLK box, grown only as far as it must be to hold the boxes it draws — but its line boxes are the reader's evidence of what the page intends as text, which a model cannot otherwise tell from a hand drawn formula in the same panel.

Furigana stays out of the text. The prompt names the reading kana printed beside kanji, forbids merging them into `text`, and skips a region that holds only furigana. A reader still reports one now and then, and a reported reading is a line with its own translation, which is how one sentence came back as two identical columns. So the mapper drops any short kana entry whose box sits inside a wider column's own band: that is what a reading looks like, and a real line never shares another line's band. A short kana column *beside* a box is a different case and is still folded into its neighbour.

Handwriting is excluded for the same reason and a costlier one. A page can have a printed column and a hand drawn formula side by side, and a reader that reads the formula as part of the column returns a box that covers both: the label then sits off the column, the erase covers paper that held no text, and the translation carries digits that were never dialogue. The prompt calls hand drawn marks artwork, keeps them out of `text` and out of the box, and says a printed column keeps its own width. Small kana that belong to a word, such as the `っ` in `いって`, stay. A `ruby` field can carry the reading for inspection, but nothing downstream reads it.

There is one entry per text line, never one entry for two columns. `box` is the number printed on the rectangle that holds the line, and it is the position: the parser takes the frame from that rectangle, not from any coordinate the model wrote. `x` and `y` are page pixels read off the numbers printed on the grid, and they are only a fallback for a crop whose numbers could not be read — a model that answers them mixes the units often enough that they cannot be the position.

#### The Drawn Grid {#the-drawn-grid}

The crop carries a grid when the model sees it, and every line of it carries the page coordinate it sits on: the numbers along the top edge are blue and are that line's x in page pixels, the ones down the left edge are red and are its y, and every fifth line is drawn thicker with its cell index in grey. The column numbers are laid flat and staggered over two rows, because the space between two lines is narrower than a four digit number.

This replaced a grid of twenty cells on the long side, and the reason is the drift. One cell was as wide as a character, and a cell box quantises upward: a 30 pixel glyph touching two 25 pixel cells was answered as two cells wide, which doubled the font and centred the label half a character off its column. At about twenty canvas pixels between lines the grid is a third of a glyph, and printing the page coordinate on each line means the answer needs no multiplication and no counting — the older grid numbered only the edges, and a reader that had to interpolate between 0 and 5 answered a column the grid did not have.

Turned digits do not work for this. The first version printed the column numbers a quarter turn to fit them, and the reader returned 62 for the line printed 42 and then answered the boxes from an estimate; the same numbers laid flat were read correctly on the first try.

A box read as page pixels is taken as it is. An answer in the pixels of the crop image itself is divided by the crop's scale, and an answer in cells is still mapped by multiplication, so a reader that ignores the numbers does not lose the line — but those are fallbacks now, and the frame comes from the named rectangle.

A region that claims to hold two columns of text (`columns` 2) is still cut in two, right to left, because the reader sometimes merges a pair of short columns into one entry.

An answer that still speaks in fractions is accepted as a fallback. A leaned line cannot be described by the axis aligned box alone: the width of that box is the glyph plus the run's whole lean, so a 22 pixel glyph on a 135 pixel column came back as a 78 pixel box and a 57 pixel font.

The reader is asked for `lean` (degrees clockwise from upright) and `em` (one character in page pixels), but it still answers `direction: "v"` and `lean: 0` for the two tilted blocks on the 四十歲 page, and on another run it answered `lean: -20` for a column that leans `+5`. The reader's lean is therefore **not stored on the region at all**: geometry is not something to take from a model that has the sign wrong. Only its `em` is kept, as a second opinion on the glyph size. If the mask gives no measurement the label is left upright, not rotated by the guess.

`leanOfBox` takes the segmentation plane inside the blue rectangle, finds the major axis of the glyph pixels, and folds it against the page axis: a vertical column near -90 degrees is a few degrees off, and those degrees are the lean. The frame is a rectangle of that lean — thickness is the glyph, length is the column run measured along the lean — and the page box is the rotated rectangle's axis aligned bounds. Several entries that name one blue rectangle are split across the reading axis first; one entry that arrived as one character per line is folded back into its column.

The font follows the same measurement. `em` from the reader is one opinion; the interquartile width of the ink across the lean is another. A single column uses the run divided by its characters, floored at 0.85 of that pitch; a merged box uses the narrower of the reader's em and the ink. A leaned line's label is drawn at that glyph size without the 1.2 correction an upright column needs, because the upright width is the column, not the glyph.

#### Where The Font Comes From {#where-the-font-comes-from}

The font is the ink, not a second measurement. The frame is the blue rectangle the reader named, so the character's width is the width of that rectangle across the line, and the label is laid out there: a translation fills the space the original filled instead of a guessed one. When the reader names nothing and no box is left to match, the frame falls back to the reader's own box, and the font to that box's side across the line.

The same frame is what the placement check measures, against the boxes the detector drew: see [regression.md](regression.md#placement-where-the-label-lands).

When a translation is shorter than the box it fills, the spare room goes into the gaps between the characters, so the label covers the box instead of bunching at its top. The spacing is in em, so it follows the font when the fit shrinks the label.

4. Each region becomes a line box with its text and its direction, and each block becomes one group. The reading order inside a block is right to left for vertical text and top to bottom for horizontal text.

#### The Translation Pass {#the-translation-pass}

Translation is a second pass, one request per block, after the reading has finished. The block's lines go out as the structured payload the target project uses: plain text, text with its visual breaks, reading order, and one entry per column with its character count, so the model knows how much room each column must fill. The rest of the page travels with the request as context — listed and explicitly not translated — so a request about one block still knows what the conversation around it said.

The pass runs at the effort the popup stores. Thinking pays here — the reading is a transcription, while the translation has to reorder clauses, pick a register and split the result back into columns — but it is also the whole wall-clock cost of a page, so the prompt is written to hold up with it off; see [Thinking Off Still Translates](#thinking-off-still-translates). Four requests are in flight at once.

The answer is written back into the block it came from (`group.translations`), so the block carries the translation it produced, the layout uses it directly, and a second run does not translate the same block twice.

#### Thinking Off Still Translates {#thinking-off-still-translates}

The popup offers a reasoning level for the translation, and the lowest level turns the chain of thought off. Thinking is the wall-clock cost of a page — one request per block, and at the high level a block spent 1.4k completion tokens of which 1.37k were reasoning — so off is the level the extension defaults to, and the prompt is written to hold up there.

Turning thinking off removes the scratch work the model would otherwise do before answering, so the system prompt carries that work instead: four steps to restore the sentence (who says what to whom, in what tone), reorder it into Chinese, make it colloquial, and check for additions and omissions. The prompt also names the idioms that came back wrong on every measured run: 「ああ」 is 啊／嗯 and not 對, 「そうだ」 is 對／沒錯, 「勝手に」 is 隨自己高興／自作主張 and not the stiff 擅自, and 「教えてあげよう」 is said to the listener — 我來告訴你 — not 告訴他. A one- or two-kana sound with an ellipsis (`うっ…`, `うつ…`, `あっ…`) is a moan, not a word: the model read `うつ` as the noun 憂鬱 / 鬱悶 in a bubble where the character had just woken up, at both effort levels, until the rule said so. It now reads 唔…… at off and at high. Names are covered by a rule of their own: kana names are transcribed (エルマ→艾爾瑪), kanji names stay kanji, and a Japanese honorific becomes the Chinese one (伯爵様→伯爵大人).

The honorific half of the name rule is enforced in code as well. 伯爵様 reached the overlay as 伯爵様 on a run where the reader filed it as `chat` rather than `name`, so `loneGlyph.ts` replaces a trailing 様 with 大人 on every answer, whatever type came back. The swap runs after the length rules, because 伯爵大人 is one glyph longer than the source and the name-length check would otherwise read the name as having grown a word.

The last lever is sampling. The same block, translated three times at temperature 0.3, gave 告訴他 / 告訴你 / 告訴你; at temperature 0 it gave 告訴你 three times out of three. A faithful translation wants the same answer twice, so the call now asks for temperature 0. This is the one change that is purely about thinking-off: with thinking on, the reasoning tokens already absorbed most of the variation.

On the three test pages the off level then reads like the high level: 「我決定帶上這兩個人，讓他們隨我高興使喚了」 (high: 「…讓他們任我隨意使喚」), 「因為大家都叫我快逃啊」, 「其實我是來找艾爾瑪的……」. What still differs is the reader, not the translator: a fresh detection groups the same balloon differently between runs, and that changes the sentence more than the effort level does.

#### Who Owns The Columns {#who-owns-the-columns}

The translator is asked which column each part of its translation belongs to: `columns` has one entry per detected column, in final reading order, each within one character of the source column's count. That is the "the translation decides which region to fill" half of the request.

The fit still owns the answer. `fitColumns` accepts the translator's split only when it has one entry per line, joins to the same translation, cuts only between the pieces the translator declared unbreakable (`segments`), and fits at a font factor of at least 0.85. Anything else falls back to the dynamic program, which can only cut between pieces and balances the text against the real capacity of each column. The word-boundary check is new: the model's own split put 艾爾瑪 in two columns on one run and 艾薩斯 on another, and a name cut across columns is not a layout the fit accepts at any font size.

#### One Balloon, One Group {#one-balloon-one-group}

The reader reports one region per column, and the block path groups regions back into balloons before translating: `splitGroupByColumnGap` cuts a merged block where the columns leave a gap across the reading axis. It was written for the detector's ink-tight boxes. The reader's boxes are snapped to a grid of whole cells, so its gaps are whole cells too, and two columns that touch can come back three cells apart.

On the first test page that split one speech into four groups — この2人 / 連れて / 勝手に動かせて / もらうことに / したんだよ — and each group was translated alone: 「帶上這兩個人」「擅自操控我」「決定收下」「是他做的喔」. One sentence, four wrong translations.

The split now also asks whether two columns share a band: if their runs overlap most of the way and they start on the same line of the block, they are columns of one speech whatever the gap says, and the allowance for that gap widens to two and a half character widths. Columns in different balloons sit in different bands, which is the case the splitter exists for.

#### One Piece Of Ink, One Line {#one-piece-of-ink-one-line}

The block head does not always answer with disjoint boxes. On the page with the 花岡修太郎 name plate it answered three blocks for two pieces of ink: the plate (`212,958 79x339`), the caption (`99,1228 38x237`), and a loose box (`94,962 193x525`) that covered both. The non maximum suppression is an IoU test, and a container against its child is a small IoU, so the nested pair survives.

Every block is cropped and read on its own, so the plate was read twice. Worse, the loose block's grid was twice the cell size, so it reported 花岡修太郎 and 三十九歳 as one line. Both readings were true, and both reached the page: two groups over the same columns, the caption read twice, and each group's source holding the other block's copy — `花岡修太郎…普通職員 花岡修太郎…`, `人生失敗組啦……人生失敗組啦`. The translator translated what it was given, so the duplication was in the reading, not in the translation.

`dropRepeatedReadings` runs after the reading pass. A block nested inside another block's box is the tighter reading of that ink, so the container's region is dropped when its word is the word of a region inside it, when its word is the join of a run of them, or when it simply lies on one of their boxes — the two grids need not agree on the cell box, and they do not have to agree on the glyph either: the loose block read 三十九歳 where the tight one read 二十九歳. Two blocks that are not nested repeat each other only when their boxes overlap and the words match, so an identical line in the next balloon is left alone. A block whose regions are all repeats is left with none and is dropped by the existing filter, so it neither asks for a translation nor gates the erase.

The invariant is asserted, not eyeballed: `npm run regression -- name-plate` fails when one piece of ink is read twice, when two groups cover one block, or when one translation repeats five or more glyphs of itself.

#### What Inpainting Uses {#what-inpainting-uses}

The block path builds the erase mask from the `det` plane, not from `seg`. The region boxes say where to erase; the det bands inside them say which pixels belong to the strip. `refineMask` then grows every band by about a fifth of the line thickness, which covers the soft edge of the glyphs.

A box whose centre falls inside a balloon never reaches the generative model. The inside of a balloon is one flat colour, so the pass fills and stops, with the tone sampled from the balloon's own paper, or plain white when there is no sample. A model asked to invent a balloon interior is what once returned a black one, and it is also slower than a fill.

Two conditions decide a fill, and no third one. The box is inside a balloon, and the fill stays inside the box. The balloon outline is deliberately not used as a clip: the seg polygon is coarse, and a fill that stopped at its edge left the bottom of a column on the page — the top of the balloon was cleaned and the last few kana stayed. The line boxes are already tight and already inside the balloon, so a rectangle filled to its own edges covers the text completely. The mask path, for boxes whose paper is unknown, fills only where the seg plane found ink, grown by `refineMask`, which is the same two conditions with the ink as the second one.

The detector's line boxes — the blue rectangles drawn on the reader's crop — are filled whole rather than masked. A masked fill only replaces the pixels the det plane calls ink, so a soft glyph edge survives as a grey rim, and the reader's own box can sit a cell off the row. A line box is tight around its text, so filling its rectangle leaves nothing behind.

The colour of that fill is read from the ring of paper just outside the box, not from the whole balloon: the median of a band a few pixels wide, clipped to the balloon outline. A balloon can sit over screentone, carry a gradient, or have its median dragged by its own ink, and the ring is exactly the paper the glyphs were printed on. The balloon's median is the fallback when the ring has nothing to read.

This is the main trade of the path. `seg` marks actual ink and keeps the erase tight; `det` is a shrunken band, so the mask leans on the growth step. On flat balloon paper the fill hides the difference. Over artwork the mask is less precise than the stroke mask, and a ghost edge is the failure to watch for.

#### Erasing A Block, Not Painting It {#erasing-a-block-not-painting-it}

A translated block is erased through BLK and DET, and nothing else: the block is the area, the det plane says which pixels inside it are text, and the strokes are replaced by the inpaint pass. The block rectangle is never filled. An attempt at "just erase the whole block" did exactly that — the block's own area, painted flat — and the result was a white slab laid across two balloons: the wall, the screentone outside it and the artwork inside it went with the text. The render was obviously wrong and the fix was to go back to a mask.

Whether a block is erased at all is decided by its **source lines**, not by the label frame: a label is drawn at the reader's cell box, and on a two-glyph bubble that box sat a few pixels above the block, so a gate keyed on the label skipped the block and left the Japanese under the Chinese.

Two things about the area. It is the crop the reader was given, not the block box: the crop is the block grown by its margin and by every det box drawn on it, and a column can sit outside the block box while still being inside that crop. `そうだ` did, and it stayed on the balloon beside its translation because the erase area — the union of the columns that got a label — stopped a few pixels short of it. And the erase covers the frame the label is drawn on as well as the ink box, because the two differ by a cell when the reader's box sits off its strokes: what the label covers must be what the erase covered, or the edge of a glyph shows beside the Chinese.

The mask itself follows the ink rather than stopping at the det band. DET is a shrunken band, so a column whose band sits a few pixels off its glyphs keeps the tail of its last stroke; the zone walks outward, eight-connected, into any pixel that differs from the paper, and stops after eight pixels, at a ruled line, at a kept line, or at the area edge. A glyph is then covered whole and the paper around it is not.

Two rules keep that mask inside the balloon. A band is grown **across** its own width, not along its run: it is a column that is too thin, not too short, and growing it along its length pushed the mask past the top and bottom of the speech and into the wall. And the fill is the **stroke silhouette** — the ink grown by two pixels — not the whole zone. The zone is a band grown well past the glyph, so filling it whole laid a white blob across the balloon; the band's interior is paper already, and filling it bought nothing. What is left is a mask the shape of the text, which cannot reach a wall the text does not touch.

The balloon outline is deliberately not used as a clip here. The bubble model returns an outline per balloon, and on the test page one of them came back as a polygon spanning the whole page: clipping to it would erase the page, and clipping to a usable one leaves the bottom of a column behind — which is the failure that produced the original rule. What keeps the fill off the artwork outside a balloon is the tight line box and the det mask, not the wall.

#### A Short Kana Word The Reader Turned Into Kanji {#a-short-kana-word-the-reader-turned-into-kanji}

`ねえ` came back as `お元` on one run, as `我元` on another, and once as two separate kanji regions, `我` and `死`. The recogniser read the same box as `ねえ` at 0.99 every time. A short stretch of text whose reader result is not kana is confirmed against the device for the same reason a one-glyph name is: the recogniser is trained on the script, and there is no sentence around the line to correct a wrong glyph.

The check runs on the **block** first and on the line second. On the block, because a two-kana bubble can come back as two one-glyph regions, and no per-line check ever sees a line long enough to doubt — `我` and `死` are each a plausible name. The block's box is one word to the recogniser. On the line, for a block whose regions were right but whose reading was not. In both cases the device text is adopted only when it is kana, has the same number of glyphs, and scores above 0.9 — a different reading of the same box, not a different line. Lines that already read as kana (`え？`, `うん`) are left alone, and so is a long line, where the device is the less reliable of the two.

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

The reader calls `deepseek-flash` and never thinks: its request carries `thinking: disabled`, whatever the popup holds, because reading glyphs is perception and the layout that goes with it is arithmetic on the grid. The translation call is the one that gets a chain of thought, at the level the popup stores: the API maps every level onto low, high or max and thinks at high by default, so those three are offered, plus off. Off is the default for translation, because thinking dominates the time a page takes and the prompt carries the procedure instead; see [Thinking Off Still Translates](#thinking-off-still-translates).

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

### A Balloon That Holds One Character {#a-balloon-that-holds-one-character}

A balloon can hold one character and nothing else. On the page this work started from, a small balloon holds 円 with its reading つぶら printed beside it: it is a name, not a sentence, and the balloon is small enough that a phrase cannot fit in it. Three separate things went wrong there, and each one is fixed where it happens.

#### The Block Head Missed The Balloon {#the-block-head-missed-the-balloon}

The `blk` head found seven blocks on the page and none of them was the 円 balloon. Every text line in the block path comes from a block crop, so a detected line that no block covered was silently dropped: the `det` head had marked it (`179,379 46x91`, beside `225,379 22x91` for the reading), and nothing read it.

The block path now reads those lines. After the blocks are read, a `det` box whose centre is inside no block and that overlaps no reported region by more than half is read on its own with `readUnclaimedLine`: its own crop goes to the cloud reader, and the device recogniser stands in when that request fails. The line joins the collected lines, and the column gap split below gives it a group of its own, so it is translated and placed like any other.

The pass is capped at six lines. Lines it reads are logged as `[read] unclaimed line`.

#### The Reader Folded The Reading Into The Name {#the-reader-folded-the-reading-into-the-name}

The reading つぶら sits beside 円 at a smaller size. A reader that reported it as a line of its own gave a four-glyph name `つぶら円`, which no spelling rule can recover, and a reader that reported it as a second region gave the balloon a second label. Two filters already existed for furigana; both refused to act on a host of one glyph, because the tests compared advance per character, and a one-character host has no advance to compare against its neighbours.

`dropReadingsInsideColumns` now accepts a one-glyph host: a kana box beside it, overlapping it along the column and clearly thinner, is a reading and is dropped. `mergeCompanionRegions` drops a kana companion of a one-glyph host for the same reason instead of folding it into the name.

The reading's ink still has to go. The reader does not report it at all once the prompt says it is not text, so there is no box to erase. The rule is the balloon: a balloon whose text is one character holds nothing else that is text, so `translateGroups` adds the whole balloon to the erase set for that group. The inflated balloon clears the reading along with the character, and a smear of kana beside the translation is what it looked like when that was missing.

#### The Translator Wrote A Phrase {#the-translator-wrote-a-phrase}

A model asked for natural Chinese turns 円 into 日圓 and then into 是錢的意思. The balloon then holds a sentence where one character was printed, and the fit shrinks it until it is unreadable inside the balloon it cannot fill.

The answer shape has a third type for this: `name`, beside `chat` and `sfx`. Both prompts say what it means — a box that holds a name, a title, a place name or a label and no sentence — and both say that a region of one character keeps that one character, in its Traditional form when the forms differ. A name is not skipped: it is written, the way a name plate is written.

The prompt is a request, so the rule is also enforced in code. `preserveLoneName` in `src/lib/loneGlyph.ts` rewrites the answer for a one-character source: an answer of one character is kept, so 圓 passes, and anything longer is replaced by the source character. A `name` answer that grew a note, a parenthetical or a sentence falls back to the source name. It runs on every answer in `translateGroups`, on both the path that reuses a translation and the path that asked for one, so no route into the overlay skips it.

#### One Glyph Is The Whole Label {#one-glyph-is-the-whole-label}

A name of one character has no context to correct it: the reader answered `門` for `円` on one run in eight, and 門 is a perfectly good glyph with a perfectly good translation. The recogniser trained on printed manga read the same box at 0.99, so the block path confirms a one-glyph line against the device before translating it, and adopts the device reading when it is above the usual 0.7 floor and disagrees. A low confidence leaves the reader's text alone: this is a tie-break, not a replacement reader. The line is logged as `[read] one-glyph line … re-read as …`.

This is the same policy the line path has always used — a confident device reading is never replaced by a general vision model — applied where it matters most, because one wrong glyph is the entire label rather than one word of a sentence.

#### The Check {#the-check}

`npm run render:page` runs one page through this pipeline and asserts the result, locally. See [Rendering A Page Locally](#rendering-a-page-locally).

For the page above, the accepted area is `179,149 143×322` — the padded crop the block reader saw for the balloon above 円. The run passes when the balloon that holds 円 holds exactly one glyph, `円` or `圓`, and the labels inside that area are that one glyph plus the neighbouring balloon's sentence.

### Remaining Limits {#remaining-limits}

Stylised handwriting still costs recognition confidence: two columns on the narration page read at 0.76 and 0.82. Both stay above the 0.7 floor, and the cause is the recogniser, not the box.

A line that the `det` head misses, that sits outside every balloon, and that has one glyph is not detected. A large sound effect outside a balloon is detected only when the `det` head marks it. The harness and the build both run on the WASM provider by default; WebGPU is opt-in through `chrome.storage.local.inferenceBackend`, so the measured path and the shipped path are the same unless someone asks for the GPU.

The model is the limiting factor for stylised lettering. A different detector export, such as the `detector.ort` asset in ShinobuTranslator, may mark those lines. The pipeline would accept it without a change, because the seed rule only depends on one line band per column.

### Rendering A Page Locally {#rendering-a-page-locally}

`scripts/render-page.mjs` runs one image through the extension's own passes — detection, the block reader, the translation, the layout, the erase — in Node, paints the overlay the way the content script does, and checks the balloons whose source is one character. It is the same code the extension ships: `runDetection` and `runInpaint` are imported from the offscreen document, not copied.

```bash
npm run render:page -- fixtures/page.jpg
npm run render:page -- fixtures/page.jpg --crop 179,149,143,322 --expect '円,圓'
```

`--expect` names the glyphs the page must show, whatever the reader transcribed. Without it a one-character balloon may hold its source glyph and that glyph's Traditional form; with it, `円` and `圓` are the only accepted answers, so a reader that turns the glyph into `門` fails the run instead of passing it on the misread source.

The key comes from the git-ignored `.env` (`VITE_DEEPSEEK_API_KEY`) or `DEEPSEEK_API_KEY`. The canvas build is resolved from `CANVAS_ROOT`, this repo's `node_modules`, or the ShinobuTranslator checkout; see `scripts/harness/env.mjs`.

It writes `out/<name>-translated.png`, `out/<name>-crop.png` for the requested area, `out/<name>-balloon-<glyph>.png` for each one-character balloon, and `out/<name>-report.json`. The run exits non-zero when a one-character balloon holds anything but that character, when nothing is placed in it, or when the rendered balloon reads more than one glyph.

`npm run prompt:lab -- out/eval/det-320.json --effort off` measures the translation prompt alone against a captured detection: it rebuilds the same regions, asks the model, and prints each region's translation next to the columns it chose, with two counted checks — a column longer than its source column plus one, and a name cut across two columns. It exists because the reader returns slightly different cell boxes every run, and a different grouping moves the translation more than a prompt change does; comparing prompts on a fresh detection each time measures the reader, not the prompt. Capture one with `npm run render:page -- fixtures/page-320.jpg --save-detection out/eval/det-320.json`.

Two witnesses are reported for each one-character balloon. The label is the pipeline's own answer and is what gates the run. The reader call then reads the rendered balloon back; it reads 圓 as 員 now and then, because the enclosing box looks like a balloon outline to it, so a single-glyph disagreement is a warning and only extra glyphs fail. Before the network request, a table of the answers the model has actually given for 円 is checked by `preserveLoneName`, so a regression in the guard fails without spending a request.

### The Regression Suite {#the-regression-suite}

The bugs in this document each cost a round of measuring, so each one is a case now: `npm run regression` replays the images in `fixtures/` through the pipeline, renders them, and checks the invariants that were broken. It exits non-zero when one comes back. [regression.md](regression.md) lists the cases, the assertion vocabulary, and how to add one.

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
