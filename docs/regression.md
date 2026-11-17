# Regression Suite

A case is one image plus the invariants that were broken once. `npm run regression`
replays every case through the real pipeline, renders the page, and checks them.

```bash
npm run regression                 # every case
npm run regression -- groan        # one case, by id
npm run regression -- --effort high  # every case at a level other than its own
```

Every run writes `out/regression/<id>.png` (the rendered page),
`out/regression/<id>-erased.png` (the erase cutout, so a leftover can be seen
directly) and `out/regression/report.json` (each case's groups, erase share and
failures). The suite exits non-zero when a case fails, so it drops into CI as is.

## Why it is asserted on behaviour, not on exact text

The reader returns slightly different boxes on every run and the translator is a
model. A case that demanded one exact sentence would fail on a rephrasing and
pass on the regression it was written for. So each case names the words that
must appear (`contains`, `oneOf`), the words that must not (`notContains`,
`forbid`), and — for the erase — a share of strokes rather than a pixel diff.

## The cases

| id | image | invariant |
|---|---|---|
| `circle` | `page.jpg` | A one-character balloon holds `円` or `圓`; never 日圓 / 是錢 |
| `names` | `page-322.jpg` | `伯爵様` is written `伯爵大人`, never with the Japanese 様 |
| `groan` | `page-groan.jpg` | `うっ…` / `うつ…` / `うふ…` is a short sound, never 憂鬱 / 鬱悶 |
| `groan-high` | `page-groan.jpg` | The same sound at thinking high, so the levels agree |
| `kana-misread` | `page-322.jpg` | The `ねえ` bubble is handed over as kana, not お元 / 我元 / 我死 |
| `balloon-split` | `page-320.jpg` | この2人連れて勝手に動かせてもらうことにしたんだよ stays one group |
| `erase-321` | `page-321.jpg` | No Japanese under a label: ≤2% of the strokes under any label survive |
| `erase-324` | `page-324.jpg` | A block whose columns were only partly labelled is still erased |
| `name-plate` | `page-name.jpg` | One piece of ink is read once: the plate nested in a bigger block is not translated twice |
| `incline` | `page-forty.jpg` | A leaned block is drawn leaned, at the source glyph size: the TV speech and the 卒業証書 banner, whatever the reader says about the lean |

## Placement: where the label lands

The checks above judge the reading and the wording. `npm run grid:drift` judges
the geometry: the frame each label is drawn on, against the ink boxes the
detector drew on the reader's crop — the blue rectangles the prompt calls the
text to read.

```bash
npm run grid:drift -- --all                              # every page in fixtures/drift.json
npm run grid:drift -- --image fixtures/page-wizard.jpg   # one page, live reading
npm run grid:drift -- --detection out/eval/det.json      # replay a frozen reading
```

A frame passes when its centre is within 8 page pixels of its ink on both axes
and its own width and height are within 25% of the ink's. `--save <json>` freezes
a reading so a failure can be replayed after the model has moved on, and
`--crops <dir>` writes the image each block was read from: the grid is the only
thing that explains a drift, so a failure is not diagnosable without it.

The frames are built from the detector's boxes, not from the reader's estimate —
that is the fix the check protects. The page passing is not enough on its own:
the reader names the column, so a block where it drops a column still land one
label on the wrong ink, and the run prints it.

## Adding a case

1. Copy the page to `fixtures/`, e.g. `fixtures/page-330.jpg`, and commit it.
2. Add an entry to `fixtures/regression.json`:

```json
{
    "id": "moan-330",
    "image": "fixtures/page-330.jpg",
    "note": "what broke, in one line",
    "effort": "off",
    "forbid": ["whole phrases that must never appear"],
    "groups": [
        {
            "source": "^う(?!ん)",
            "oneOf": ["唔", "嗚"],
            "notContains": ["憂", "鬱"],
            "onMissing": "skip"
        }
    ],
    "erase": { "maxUncoveredShare": 0.02 }
}
```

3. `npm run regression -- moan-330` and look at `out/regression/moan-330.png`.
4. Keep the assertion to what the fix guarantees. If the reader may not report
   the balloon on a given run, say `"onMissing": "skip"` — otherwise the suite
   measures the reader's luck.

### Assertion vocabulary

| key | meaning |
|---|---|
| `forbid` | no group's translation may contain any of these strings |
| `groups[].source` | regex matched against a group's source text |
| `groups[].at` | `[x, y]` in page pixels; picks the group whose box holds the point |
| `groups[].contains` | every string here must appear in the translation |
| `groups[].oneOf` | at least one of these must appear |
| `groups[].notContains` | none of these may appear |
| `groups[].maxGlyphs` | the translation may not be longer than this |
| `groups[].sourceIsKana` | the group's source must be kana only |
| `groups[].onMissing` | `skip` when the reader may not report the group |
| `loneGlyphs[]` | `{ source, allowed }`: exactly one of `allowed`, exactly one glyph |
| `labels[].region` | `[x, y, width, height]` in page pixels; every label whose centre is inside is checked |
| `labels[].lean` | the label's rotation in degrees, clockwise, with `leanTolerance` (default 4) |
| `labels[].em` | the source glyph size in page pixels, with `emTolerance` (default 0.3) |
| `labels[].source` | regex matched against a group's source; only that group's labels are checked |
| `labels[].onMissing` | `skip` when the group or its label may not be reported |
| `labels[].emMaxGlyphs` | a longer label skips the font rule (it is a merged line, not a glyph measurement) |
| `sources.mustNotMatch` | no group's source may contain these |
| `oneInk` | no piece of ink is read twice: no two overlapping lines with the same word, no line that is the join of the lines it covers, no two groups over one block |
| `maxRepeat` | no translation may repeat a run of this many glyphs of itself |
| `erase.maxUncoveredShare` | share of strokes under a label that may survive |
| `effort` | level for this case; the run's `--effort` overrides it |

`labels` measures what was drawn, not what the reader said: the reader answers
`direction: "v"` and no lean for a visibly tilted column, so the pipeline has to
measure the ink itself. The rule also fails two labels that cover more than 40%
of one another, which is the sign of two columns sharing one box.

`oneInk` measures the reading, and it is the one invariant here that does not
depend on the model at all: the blocks, the lines and the groups either describe
the same ink twice or they do not. `maxRepeat` measures the translation and is
the tolerant half: the threshold sits above a phrase a speaker may say twice on
purpose (我愛你…我愛你 is four glyphs), so a repeat long enough to trip it means
the source carried the text twice.

## The loop that produces a case

`/tool--loop` is the general front door: it asks what to change, how to verify it
and what counts as done, turns that answer into a check, and adds the check here as
a case before iterating. Each loop leaves a record under [docs/loops/](loops/):
the criterion, the baseline, one row per round and what the user's artifacts
changed — [the label drift loop](loops/2026-11-18-01-label-drift.md),
[the incline loop](loops/2026-11-18-02-incline-and-font.md),
[the lean-sign loop](loops/2026-11-18-03-incline-sign.md) and
[the three-columns loop](loops/2026-11-18-04-three-columns.md) are the worked
example. The prompt below is the repo-specific version of the same request, for
when a fix is already made and only the case is missing.

## Asking an agent for a case

The prompt that gets a durable case out of a fix:

> When you fix this, leave a regression case: copy the page to `fixtures/`, add it
> to `fixtures/regression.json` with the invariants that were broken (the exact
> region or crop, what the output must and must not contain), run
> `npm run regression -- <id>`, and show me the case's rendered PNG. Say which
> assertions are stable and which depend on the reader reporting the balloon.

The parts that matter: name the image and the exact area, state the invariant
rather than the sentence, ask for the image to be saved with the case, and ask
which assertions are stable — that last one is what stops a suite from failing
on the reader's run-to-run variance.

That prompt is specific to this repository. [regression-prompt.md](regression-prompt.md)
is the same request with the paths and the command removed, for use in another
codebase: it asks the agent to follow that repo's conventions, to prove the test
fails before the fix, and to name its nondeterminism.
