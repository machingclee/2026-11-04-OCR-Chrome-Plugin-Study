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
| `sources.mustNotMatch` | no group's source may contain these |
| `erase.maxUncoveredShare` | share of strokes under a label that may survive |
| `effort` | level for this case; the run's `--effort` overrides it |

## The loop that produces a case

`/tool--loop` is the general front door: it asks what to change, how to verify it
and what counts as done, turns that answer into a check, and adds the check here as
a case before iterating. The prompt below is the repo-specific version of the same
request, for when a fix is already made and only the case is missing.

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
