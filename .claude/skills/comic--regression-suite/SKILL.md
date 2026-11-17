---
name: comic--regression-suite
description: >-
  Add, replay or repair regression cases for this Chrome extension's manga
  translation pipeline. Cases are an image in fixtures/ plus invariants in
  fixtures/regression.json, replayed through the real detect/translate/erase
  pipeline by `npm run regression`, with the rendered page and erase cutout saved
  for eyeballing. Use when asked to add a regression test for a translation,
  erase, reading, grouping or one-character-balloon bug, when asked to run or fix
  the regression suite, or after fixing such a bug when it must stay fixed.
---

# Comic translator regression suite

One case = one page image + the invariants that were broken once. The runner
replays the page through the extension's own pipeline in Node, renders it the way
the content script does, checks the invariants, and writes the rendered page and
the erase cutout so a human can see the result.

Work with `/tool--loop`: that skill asks what to change, how to verify and what
counts as done, and this one supplies the repository-specific half — where cases
live, how the runner works, and which invariants were already broken.

## Mandatory trigger

Invoke this skill when the user asks to:

- "add a regression test/case" for this repo
- keep a translation / erase / reading / grouping fix from coming back
- "run the regression tests", "rerun the 320 case", "make sure 円 still works"
- add a new test page to the suite

## Commands

```bash
npm run regression                        # every case
npm run regression -- circle              # one case, by id
npm run regression -- --effort high       # every case at another level

# one page, by hand, with checks and artifacts
npm run render:page -- fixtures/page.jpg --crop 179,149,143,322 --expect '円,圓'
npm run render:page -- fixtures/page-320.jpg --save-detection out/eval/det-320.json
npm run render:page -- fixtures/page-320.jpg --detection out/eval/det-320.json   # replay

# the translation prompt alone, against a frozen detection
npm run prompt:lab -- out/eval/det-320.json --effort off
```

## Files

| Path | Role |
|---|---|
| `fixtures/regression.json` | the case list: image + assertions |
| `fixtures/*.jpg` | committed test pages — a case is only replayable if its input is in the repo |
| `scripts/regression.mjs` | the runner, `npm run regression` |
| `scripts/harness/page.mjs` | `runPage()`: detect → translate → erase → paint. Single copy, do not duplicate it |
| `scripts/render-page.mjs` | the one-page CLI (`render:page`) |
| `docs/regression.md` | the human guide: cases, vocabulary, how to add one |
| `out/regression/` | per run: `<id>.png`, `<id>-erased.png`, `report.json` (git-ignored) |

## Adding a case

1. Copy the page into `fixtures/` — `fixtures/page-<n>.jpg`, committed.
2. Append to `fixtures/regression.json`:

```json
{
    "id": "moan-330",
    "image": "fixtures/page-330.jpg",
    "note": "what broke, in one line",
    "effort": "off",
    "forbid": ["杞憂", "鬱悶"],
    "groups": [
        { "source": "^う(?!ん)", "maxGlyphs": 4, "notContains": ["憂", "鬱"], "onMissing": "skip" }
    ],
    "erase": { "maxUncoveredShare": 0.02 }
}
```

3. Run `npm run regression -- moan-330`, then look at the two PNGs.
4. **Prove it is a real test**: revert or stash the fix, run the case, and show it
   failing; restore the fix and show it passing. A case that passes on both is
   asserting nothing.
5. Report which assertions are stable and which depend on the reader reporting
   the balloon that run.

## Assertion vocabulary

| key | meaning |
|---|---|
| `forbid` | no group's translation may contain any of these strings |
| `groups[].source` | regex matched against a group's source text |
| `groups[].at` | `[x, y]` in page pixels; pick the group whose box holds the point |
| `groups[].contains` | every string must appear in the translation |
| `groups[].oneOf` | at least one must appear |
| `groups[].notContains` | none may appear |
| `groups[].maxGlyphs` | the translation may not be longer than this |
| `groups[].sourceIsKana` | the group's source must be kana only |
| `groups[].onMissing` | `skip` when the reader may not report the group |
| `loneGlyphs[]` | `{ source, allowed }`: exactly one of `allowed`, exactly one glyph |
| `sources.mustNotMatch` | no group's source may contain these |
| `erase.maxUncoveredShare` | share of interior strokes under a label that may survive |
| `effort` | level for this case; `--effort` overrides it |

## Criteria this suite encodes

The loop (`/tool--loop`) writes the check first; these are the project's shapes for
the checks it writes. Each row is a criterion that was written in prose once and
then had to become a case.

| Prose | Case |
|---|---|
| "shouldn't be translated as 憂鬱" | `forbid: ["憂鬱", "鬱悶", "抑鬱"]` + `maxGlyphs: 4` on the `^う(?!ん)` group |
| "the inpaint must not cross the bubble" | `erase.maxUncoveredShare: 0.02`, measured under labels on interior ink |
| "must still display 円 or 圓, one character" | `loneGlyphs: [{ source: "円", allowed: ["円", "圓"] }]` |
| "off must be as good as high" | `groan` and `groan-high`: the same group, the same `oneOf`/`forbid` |
| "the name must not keep its Japanese honorific" | `groups: [{ source: "伯爵", contains: ["大人"], notContains: ["様"] }]` |
| "no kana left in a translation" | global check in the runner: kana in any non-empty answer fails |
| "the reader must not hand over kanji for ねえ" | `sources.mustNotMatch: ["お元", "我元", "我死"]` + `sourceIsKana` at `[176, 700]` |

## Rules that keep the suite honest

- **Assert the invariant, not the sentence.** The translator is a model and the
  reader returns different cell boxes each run. `contains` / `oneOf` /
  `notContains` / `maxGlyphs` survive a rephrasing; exact text does not.
- **Say when the reader may not report the balloon.** `"onMissing": "skip"` and
  print the skip in the output. Without it the case fails on the reader's luck.
- **Erase is measured under the labels**, on interior ink only (ink that touches
  the box border is a balloon wall or a panel edge, not a leftover).
- **A case for `off` and a case for `high`** when effort must agree (see `groan`
  and `groan-high`).
- **Freeze a detection** when a case must be bit-for-bit reproducible:
  `--save-detection` once, `--detection` to replay. Use fresh detection for
  cases about the whole pipeline.

## Pitfalls specific to this repo

- **Never keep a second copy of the erase geometry.** The suite and the harness
  call `runPage()`; an earlier duplicate erased a narrower area than the app and
  the suite measured the wrong pipeline.
- **Do not measure ink over the block crop.** The crop contains the balloon wall
  and screentone, which are correctly not erased.
- **The erase gate is the translated source lines** (`job.erase`), not the label
  frame: a label drawn at the reader's cell box can sit outside the block.
- **Effort defaults to `off`** and translation runs at temperature 0; pass
  `"effort": "high"` explicitly for a high-level case.
- **One-character balloons** (`loneGlyphs`) only apply to kanji names; a lone
  kana is dialogue.
- The translation prompt lives in `src/lib/translatePrompt.ts`; the layout guard
  that refuses to cut a declared word is `fitColumns`.

## How to verify

```bash
npm run regression        # expect all cases passing
npm run typecheck
npm run build
```

Report: how many cases passed, the rendered path for each new case, and the
assertions that are reader-dependent.
