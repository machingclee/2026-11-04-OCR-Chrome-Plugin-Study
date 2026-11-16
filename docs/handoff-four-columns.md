# Handoff: a three line block renders four columns

Status: **open**. The user confirmed on 2026-11-16, after the overlay changes
below were built into `dist/`, that the balloon still shows the same extra
column. Do not start with another white-space tweak. The first action is the
DOM probe in section 7. It tells you whether the page is painting the new
markup or an older content script.

Build at handoff time: `npm run build` passes, `npx tsc --noEmit` passes.
`dist/pickImage.js` contains `data-comic-translator-vertical`.

**Update 2026-11-16 (H4 evidence).** Chrome's `Default/Secure Preferences`
registers the unpacked extension (`bmfpekachdcocgglcgblnpcdndepipmk`) at
`~/Repos/Javascript/2026-11-04-OCR-Chrome-Plugin-Study/dist`. At 15:23 the
repo had been moved to `~/Repos/mcp/tikz-mcp-server/`, so that path did not
exist and Chrome was not running this `dist/`. The repo is back at the
registered path and `dist/` was rebuilt. A second, older unpacked copy
(`dcefobccfenokkiagblcdnglielcagji`) is registered from the repo root, which
has no `manifest.json`. Remove it in `chrome://extensions`. Next: reload the
extension, reload the manga tab, translate again, and run the probe in
section 6. The AppleScript route for the probe is off ("Allow JavaScript from
Apple Events"), so run it in DevTools.

**Update 2026-11-16, after the reload (H2).** The new screenshot shows
`也就是` / `說人類` / `遇見外` / `星人這件事`: four separate phrases, each
one glyph wide. The `說人類` column sits where the furigana わたしたち is
printed. So the page has four labels, not one label wrapping. The reader
returned わたしたち as a fourth line, and `dropReadingsInsideColumns` kept it
because it sits beside the host column, not within 1px of its band.
`dropReadingsInsideColumns` now also drops a short kana line (8 characters or
fewer) beside a column when all of these hold: the gap is at most one host
width, the two lines overlap along the run, the kana line is no wider than the
host, and its advance (length per character) is at most 0.75 of the host's.
A same-size kana column (うん, そうなの) is still kept and folded in.
Test: `.tmp-expcheck/compare/furigana-test.mjs`. The `[typeset]` log now
prints the source lines, the placed lines and the labels, so the next run
shows the count directly.

**Update 2026-11-16, three columns, bad breaks.** With three labels on the
page, the text was `也就是說︙人類` / `遇到外` / `星人這件事`. `translationJob.ts`
ignored the translator's `columns`, joined them, and re-split the string by
source length. That cut 外星人 in two. The first label also ran past the end of
its source column. Three changes:

- When the translator returns exactly one column per placed line, those
  columns are used as they are.
- Otherwise `splitByWeight` (`punct.ts`) snaps each cut to a translator
  boundary, or to the point right after a punctuation mark, when one is within
  two characters of the weighted share.
- A label with more characters than its line holds shrinks its font to fit,
  down to 70% of the source size. The prompt now asks for exactly
  `targetColumns` parts and forbids splitting a word across two parts.

Test: `.tmp-expcheck/compare/split-test.mjs`.

**Update 2026-11-16, fit into the reader's lines (replaces the above).**
The layout is now `src/lib/fitColumns.ts`, called from `translationJob.ts`.

- The translator returns `segments`: the translation cut into words and short
  phrases that must stay whole. It also returns `ruby`: the 1-based source
  columns that are furigana. `readRegions` keeps `segments` only when they
  join back to the translation.
- Lines that get no label: the `ruby` columns, a short kana line at under 70%
  of the largest font that runs beside a larger line, and a line whose slot
  overlaps a larger line's slot. Their ink is still erased.
- `fitColumns` is a dynamic program over character cuts. It gives exactly one
  part per line. A cut costs nothing between two segments, 20 inside a
  segment (2 when the pieces only come from punctuation) and is impossible
  before a closing mark. Overflowing a line costs 100 × overflow²; uneven fill
  costs the squared distance from the shared fill ratio. The translator's
  `columns` win as they are when there is one per line and they fit at a font
  factor of at least 0.85. All lines share one font factor, floor 0.6.
- Overlay: an upright column is centred on its slot (`margin-left: -0.5em`)
  instead of hanging from the slot's left edge.

Test: `.tmp-expcheck/compare/fit-test.mjs`.

## 1. The symptom

The balloon is the one printed

```
つまり人類が        ← right column
宇宙人に            ← middle column
出会うことは        ← left column
```

with a small furigana column わたしたち beside つまり人類が.

The reader has returned three regions for this balloon (section 3). The page
shows four columns of Chinese. The latest screenshot is

`assets/image-55868425-653c-4fb4-9f30-dd0c1f6a2be7.png`

(Earth from space, white glyphs with a black stroke). Read it as three labels,
the right one split:

```
也  就          ← one phrase, 也就是說人類啊, drawn as two columns
說  是
人  啊
類
與
外              ← 與外星人, one column
星
人
相
遇              ← 相遇這件事, one column
這
件
事
```

The two right-hand columns are adjacent characters of one phrase, not two
independent translations. The short columns, which fit their boxes, stay
single. That is a wrap of the long label, not a second sentence.

"Each column is draggable" does not by itself prove four elements. One label
that wraps is one draggable element; both visual columns move together. That
was not checked on the live page.

## 2. What the pipeline does now

Popup → service worker → offscreen, then back through the content script.

1. **Detect** (`src/offscreen/main.ts`, `runDetection`): the `blk` head gives
   block boxes; `det` line boxes and the `seg` plane are kept alongside.
2. **Read** (`src/lib/ocr/cloudOcr.ts`, `readBlockRegions`): one request per
   BLK box. The crop is the BLK box plus a 10 px margin, upscaled to 220 px on
   the short side, with a numbered cell grid and the det line boxes drawn in
   blue (`src/lib/ocr/blockCrop.ts`, `src/lib/ocr/grid.ts`). The answer is one
   entry per line: `text`, `type`, `direction`, and `x/y/width/height` in whole
   grid cells. No translation, no thinking (`READ_EFFORT = 'off'`).
3. **Parse** (`readBlockAnswer`, `dropReadingsInsideColumns`,
   `mergeCompanionRegions`, `separateOverlaps`): answers become `BlockRegion`s,
   a furigana column inside a wider column is dropped, a short kana column
   beside one is folded in.
4. **Group** (`src/offscreen/main.ts`, around line 670): each block box becomes
   one `GroupData` with `lines` and, per line, a `slot` (the label rectangle)
   plus `lineThickness` (the font, set in the cell block around line 585).
5. **Translate** (`src/lib/translationJob.ts`, `translateGroups`): one request
   per block, at the popup's effort (default off), with the rest of the page
   as context. The answer is `{translation, columns}`.
6. **Lay out** (same file, around line 290 and line 369): the translation is
   split into one part per line (`splitByWeight`), then one overlay item per
   line is pushed.
7. **Draw** (`src/content-script/overlay.ts`, `makeBox`): an upright item is
   no longer `writing-mode: vertical-rl`. It is a column of one `<span>` per
   glyph. See section 5.

The content script is not a manifest content script. Every translate calls
`chrome.scripting.executeScript({ files: ['pickImage.js'] })` from
`src/background/index.ts` around line 704, then calls
`__comicTranslatorOverlay.apply`. The file that runs is the one inside the
**loaded** extension. `dist/pickImage.js` in this checkout is irrelevant if
Chrome is loading some other unpacked directory.

Relevant console lines, in pipeline order:

```
[read] block 1: {…}                     cloudOcr.ts       the raw answer
[read] dropped N reading(s) …           cloudOcr.ts
[grid] block 1: C x R cells of Kpx …    cloudOcr.ts
[cell] "…" box x,y WxH em Fpx = A across, B/C along, cell Kpx
                                        offscreen/main.ts
[erase] N line(s) read …                offscreen/main.ts
[translate] N of M block(s) translated, effort high
                                        translationJob.ts
[typeset] group 0: glyph … N line(s) …  translationJob.ts
[typeset] group 0: X label(s) for Y line(s)
                                        translationJob.ts
```

## 3. The case in hand

The reader answered (cells, from a debug card; it may be a different run from
the screenshot):

```json
{"regions":[
 {"text":"つまり人類が","type":"chat","direction":"v","x":9,"y":1,"width":3,"height":13},
 {"text":"宇宙人に","type":"chat","direction":"v","x":4,"y":6,"width":1,"height":11},
 {"text":"出会うことは","type":"chat","direction":"v","x":1,"y":6,"width":2,"height":14}
]}
```

Three lines. The harness reproduces the layout step and pushes three labels:

```
[typeset] group 0: 3 label(s) for 3 line(s)
  "也就是說︐人類遇見"  at 120 0
  "外星人這件"        at 80 60
  "事︐就等於說人類︙"  at 40 60
```

The screenshot's right-hand phrase is the same idea with different wording
(`也就是說人類啊` / `與外星人` / `相遇這件事`): one part per source column, and
the longest part is the one that appears twice side by side.

`splitByWeight` returns one part per weight. The wide-label branch in
`translationJob.ts` (the `else` that pushes `tight`) is not reachable for a
group with more than one placed line. The harness agrees. A fourth **element**
has to come from a fourth placed line or a second group. A fourth **visual**
column can still be one element laid out in two columns.

## 4. Where the count is decided

- `translationJob.ts` `splitByWeight` call: one part per placed line.
- The clamp just below it folds any excess part into the last one.
- The push:

```ts
if (columns.length > 1 && columns.length <= placedLines.length) {
    placedLines.slice(0, columns.length).forEach((line, i) => push(frameOf(line), columns[i], line));
} else if (placedLines.length === 1) {
    push(frameOf(placedLines[0]), columns.join(''), placedLines[0]);
} else {
    push(tight, columns.join(''));   // one wide label
}
```

- `placedLines` is not `group.lines`. It is every box in `detection.boxes`
  whose centre lies inside the group rectangle (`translationJob.ts`, the
  `linesInGroup` filter). A line that belongs to a neighbouring block is
  counted again when the group rectangle is the whole BLK box. That is still
  a way to get four items from three reader regions.
- The label rectangle is `line.slot` (`offscreen/main.ts` around line 585):
  for a vertical line it is one em wide, centred on the reader's box.
- `dropReadingsInsideColumns` (`cloudOcr.ts` around line 537) only treats a
  reading as "inside" the host when it sticks out by at most **1 pixel**.
  The cell grid is many pixels per cell, so a furigana column one cell beside
  the host survives this test. `mergeCompanionRegions` then folds it only when
  it is thinner than `0.55 * widest`. A reading whose box is not that thin
  stays as its own line.

## 5. What was tried in this session, and what each attempt measured

Both attempts are in `src/content-script/overlay.ts` and were built into
`dist/pickImage.js`. The user reported the symptom still present after each.

| Attempt | What it changed | What a browser measurement showed |
| --- | --- | --- |
| `white-space: nowrap`, horizontal padding 0, and `fitBoxes` no longer shrinks an upright column to make wrapped columns fit the width | Stop `vertical-rl` + `pre-wrap` from breaking a long line | With the **old** CSS (`pre-wrap`, `height: unset`, font equal to the box width, 2px horizontal padding), the string `也就是說︐人類遇見` in a 36px box had a text range **86px wide**. The box grew taller and the text still wrapped, because the line box (~1.4em, the default line box of an upright glyph) is wider than the content box. `nowrap` on that same element made the range one column tall (`9 * font-size`). |
| One child `<span>` per glyph, parent `display: flex; flex-flow: column nowrap; width: 1em; height: auto`, all of that `!important` under `[data-comic-translator-vertical="true"]` (`ensureBoxStyle`, `makeBox` when `item.vertical && !inclined`) | Make a second column impossible even if the page forces `writing-mode: vertical-rl` and `white-space: pre-wrap` | A fixture with `span { writing-mode: vertical-rl !important; white-space: pre-wrap !important; display: inline !important; height: 96px !important; word-break: break-all !important }` still laid out `也就是說人類啊`, `與外星人`, and `相遇這件事` as one column each. Glyphs of one label shared a single `x`. Heights were `7 * 32`, `4 * 32`, `5 * 32`. |

The second attempt cannot paint `也` beside `就` unless the page is not
running it. Two glyphs that are siblings in a `flex-flow: column nowrap`
container share one x. The screenshot pattern (adjacent characters side by
side) is what `vertical-rl` + `pre-wrap` produces, which is the markup from
**before** this attempt.

`fitBoxes` now returns immediately for `[data-comic-translator-vertical]` and
for `writing-mode: vertical-*`, so it will not shrink those labels.

## 6. Hypotheses that are still open

**H4 — the page is painting an older overlay. This is the one to kill first.**
The screenshot matches the pre-change wrap. The new markup was in `dist/`
when the user said it was still broken. Chrome may be loading an unpacked
extension from a directory that is not this checkout's `dist/`. Injecting
`pickImage.js` again does not help if that file, inside the loaded package,
is old. An extension reload is required after changing which directory is
loaded; a page reload alone is not.

*Check:* on the translated page,

```js
[...document.querySelectorAll('[data-comic-translator-box="true"]')].map(el => ({
  text: el.textContent,
  vertical: el.getAttribute('data-comic-translator-vertical'),
  children: el.childElementCount,
  writingMode: getComputedStyle(el).writingMode,
  display: getComputedStyle(el).display,
  width: getComputedStyle(el).width,
  whiteSpace: getComputedStyle(el).whiteSpace,
  xs: [...el.children].map(node => Math.round(node.getBoundingClientRect().x)),
}))
```

- `vertical` is null, `children` is 0, `writingMode` is `vertical-rl`: this
  is the old painter. Stop. Find the directory Chrome is actually loading
  (`chrome://extensions`, "詳細資料" / Details, the path under "來源" /
  Source) and point it at this `dist/`, or copy `dist/` over that path.
  Then reload the extension and translate again. Do not change layout code
  until this probe shows the new markup.
- `vertical` is `"true"`, one child per character, but the `xs` set has more
  than one value: the new markup is running and the column CSS is losing.
  Compare `getComputedStyle` to the rule in `ensureBoxStyle`. Look for a
  later `!important` whose selector is at least as specific as
  `span[data-comic-translator-box][data-comic-translator-vertical]`.
- Four entries, each with its own phrase: the fourth column is a fourth
  overlay item. H3 is dead. Go to H1 and H2.

**H1 — two blocks cover one balloon.** Still possible, and the
`linesInGroup` filter can count a neighbour's line inside this group even
when `group.lines` has three strings. *Check:* `[typeset] group N:` lines for
the page, and whether two debug-card crops cover this balloon. *Fix sketch:*
merge BLK boxes that overlap by more than half of the smaller one before
`readBlockRegions`, and make `placedLines` the lines that were assigned to
that group rather than every box whose centre falls inside the BLK rectangle.

**H2 — the reader returned a fourth region on the run that was screenshotted.**
The JSON in section 3 has three regions and no わたしたち. A later run can
differ. The 1px slop in `dropReadingsInsideColumns` is the wrong unit: the
grid cell is several pixels, so a kana column one cell beside the host is
kept. *Check:* the `[read] block` line for this balloon. *Fix sketch:* key
the drop on glyph size (length along the column divided by character count)
being clearly smaller than the host's, and allow a gap of about one em, not
one pixel. Do not drop a same-size kana column; that is dialogue.

**H3 — `vertical-rl` wraps one label.** Confirmed for the CSS that was in the
tree before section 5, including with `height: unset`. The current upright
path is supposed to make it unreachable. Treat H3 as open only when the probe
shows the new markup and more than one `x`.

## 7. What to do first

1. Run the probe in section 6 on the page that shows the extra column. Do
   this before editing `translationJob.ts` or `cloudOcr.ts`.
2. If the probe says the old painter is active, fix the loaded extension
   path and stop. Ask the user to translate once more. The acceptance check
   is that probe: one `x` per label, and one label per printed column.
3. If the probe says four elements, collect the service-worker `[read]`,
   `[grid]`, `[cell]`, `[translate]`, and `[typeset]` lines for that balloon
   and follow H1 or H2. `[typeset]` prints counts only; log `group.lines`
   and `placedLines.map(line => line.text)` if the counts disagree with the
   debug card.

## 8. Acceptance criteria

- A balloon with N printed columns produces exactly N labels.
- No label wraps into a second column. The text runs down its own column, at
  the font the grid gives it.
- The translation appears once. No phrase is repeated across columns.
- The erase covers the printed text (flat balloon fill, no mask clipping).
  Painting is not part of this bug.

## 9. Commands

```bash
npm run build        # typecheck + three bundles into dist/
npx tsc --noEmit     # types only
```

Harness, no API key needed (a stubbed `fetch` stands in for DeepSeek). Node
modules come from the ShinobuTranslator checkout, see
`.tmp-expcheck/compare/env.mjs`.

```bash
cd .tmp-expcheck/compare
../../node_modules/.bin/esbuild repeat-test.mjs --bundle --platform=node \
  --format=esm --packages=external --outfile=repeat-test.bundle.mjs
node repeat-test.bundle.mjs      # three lines, translation laid out; prints labels
node block-test.bundle.mjs       # reader answers → regions, cells, fonts
node card-crop.mjs               # the crop DeepSeek is sent, with grid and blue boxes
node effort-test.bundle.mjs      # request bodies per effort level
node erase-balloon-test.bundle.mjs  # flat balloon fill and solid line boxes
```

`block-test.mjs`, `grid-crop.mjs`, `card-crop.mjs` and `erase-balloon-test.mjs`
need `/tmp/dbg2/page6.png`. The file at that path today is 720×1024 and is a
different page from this balloon. Any page image works for those tests. The
1125×1600 page they were written against is not there anymore.

## 10. Rules that are easy to break

- The crop the reader sees is built **only** from the BLK box plus its 10 px
  margin. `det` is never a crop source; it is drawn as blue boxes and used as
  the erase mask.
- The grid cell size is computed once from the crop (`gridCell`) and the same
  value maps the answer back, so a change to one must not skip the other.
- The font is derived from the grid, never from fractions of the crop.
- The label's paper patch and the erase use the tight ink box; the label itself
  uses the slot. They must not be merged.
- Translation is one request per block, and the answer must be written back to
  `group.translations` and to the stored block reading.
- Upright labels and inclined labels are different elements. The glyph column
  is only for `item.vertical && !inclined`. An inclined line stays on
  `writing-mode: vertical-rl`.
- A balloon whose text is one character stays one character. `preserveLoneName`
  runs on every answer in `translateGroups`; a new path that writes a
  translation must go through it, or 円 becomes 日圓 and then a sentence in a
  balloon that holds one glyph. `name` is a third type beside `chat` and `sfx`
  and it is translated, not skipped.
- A name glyph is confirmed against the on-device recogniser, because one wrong
  glyph is the whole label: the reader returned 門 for 円 on one run in eight.

## 11. Erase rewrite (2026-11-16)

Two complaints, opposite directions:

- **Too much.** Whole det rectangles were filled with paper, padded reader
  regions (10 px) and the label slots were erased too. Where a det box covers
  a caption frame (the 京東大学… name box is one det box the size of the
  frame), the frame edges went white.
- **Too little (earlier).** AOT ran once on the whole page squeezed into its
  512 square. The mask was shrunk with "keep when > 127", so thin strokes fell
  out of the hole and the model painted the text back in.

`src/lib/erase.ts` `erasePage(page, { seg, det }, boxes)` now works per box:

1. **Paper inside the box.** Read from the pixels the seg plane leaves out.
   Flat when 88% of them sit within 26 luma of the median. The ring outside
   the box is not used: a white caption box on artwork has an art ring.
2. **Flat paper.** The text zone is the det band (det ≥ 0.15) or seg strokes
   (seg ≥ 0.15), grown by 12% of the box thickness. The strokes are the zone
   pixels more than 18 luma off the paper, plus seg ≥ 0.25. Ruled lines
   (frame edges, panel borders) are traced on the dark core (> 60 luma), per
   row and per column, so hair touching the rule does not hide it. They are
   removed from the strokes. A stroke pixel is filled with the paper colour
   only where its surroundings are mostly paper. Otherwise it goes to the
   model, as when a box straddles screentone.
3. **Not flat.** The hole is the seg strokes grown by 15% of the thickness.
4. **Model tiles.** `planTiles` cuts 512 windows around the holes, at page
   resolution whenever the text fits. A window is larger and scaled down only
   when it has to be, and then the mask is max-pooled. Each tile runs
   `inpaintTile`, and the answer is pasted back only on the hole. The
   whole-page `inpaintPage` is gone.
5. **Erase set** (`background/index.ts`). Three kinds of box are erased:
   - det line boxes (`kind: 'line'`) whose centre is inside a block that read
     dialogue, minus those that overlap a sound effect;
   - reader regions padded by 3 px (`kind: 'region'`);
   - ruby boxes.

   Label slots and `solid` rectangles are no longer erased.

Harness: `.tmp-expcheck/compare/erase-tiles-test.mjs p02 p01` runs detection
and the real model on `/tmp/dbg2/p02.jpg` (the name-box page) and
`/tmp/dbg2/p01.jpg` (the earth page). It writes `*_erased.png`. The old
`erase-balloon-test.mjs` uses the removed `paper`/`solid` API.

### 11b. BLK + DET (2026-11-16, replaces the erase set above)

The erase set was "extended DET + seg/contrast": det line boxes plus a rim,
with seg strokes and anything off the paper inside them. In the name box it
still blurred hair and broke the top frame edge. It is now **BLK + DET**:

- **Gate.** The blk box of every block that read dialogue (`kind: 'block'`),
  grown by 15% of its short side (4 to 12 px), because a halo can sit just
  outside the box. Sound-effect regions inside the block are passed as `keep`.
  Reader regions are used only when there are no block readings.
- **Text.** `maskOfBlock`: the det plane at ≥ 0.05, which is a shrunken band
  down each line. Each connected band is unclipped by 0.9 × its own thickness
  (3 to 40 px). On paper, the zone then follows the ink out up to 6 px, which
  takes halos and strokes that poke out, never across a ruled line.
- **Fill.**
  - The block is flat when 79% of its pixels outside the zone sit within 26
    luma of the median.
  - On a flat block, every zone pixel whose surroundings outside the band are
    ≥ 90% paper is filled with the paper colour. The whole band is filled,
    not glyph silhouettes, which leave visible outlines against JPEG noise.
  - Other stroke pixels go to the model.
  - Off the paper, the model's hole is the seg strokes (≥ 0.15, grown 4 px)
    within 6 px of the band. A whole band is too big a hole on screentone or
    a star field.
- Tiles at page resolution as before.

Harness: `erase-tiles-test.mjs` now feeds `detected.blkBoxes` as blocks.
`det-view.mjs pNN` draws det ≥ 0.3 (red), det ≥ 0.05 (blue) and the BLK boxes.

### 11c. Untranslated text keeps its ink (2026-11-16)

A line the translation leaves out (円… with its furigana つぶら, dropped by the
model) was erased anyway, leaving a blank hole. `runTranslationJob` now returns
`keep`: the ink boxes of lines whose fitted part is empty, of non-column lines
(furigana) whose nearest column is such a line, and of every line in a group
that came back empty or `skip`. Background adds them to each block's `keep`
(and drops fallback regions they cover). In `maskOfBlock`, a det band that is
mostly inside a keep rect grown by 0.8 × its short side is not erased, and its
own unclip area (+6 px) becomes a guard that the zone, the ink follow and the
model hole never enter.
