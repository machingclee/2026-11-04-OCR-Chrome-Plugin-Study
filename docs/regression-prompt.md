# Asking An Agent For A Regression Test

Packaged as the global skill `tool--loop`, which asks the three questions (what to
change, how to verify, what counts as done), writes the check first, saves it as a
regression case, and then iterates until it passes or the round budget is spent.

A prompt that works in any repository, because it states the outcome and lets the
agent pick the structure. The project-specific version (paths, case file, command)
lives in [regression.md](regression.md); this is the one to carry to another codebase.

## The prompt

> Add a regression test for this fix — one that would have failed before it.
>
> - Start by looking at how this repo tests things today, and follow that. If there
>   is no test setup, propose the smallest structure that fits this kind of project,
>   then build it.
> - Keep the input that reproduced the bug. If it is not already in the repo, add it
>   (or a reduced version of it) so the case can be replayed later; tell me if it is
>   too large, binary-heavy, or not redistributable.
> - Assert the invariant that was broken, not the literal output — unless the output
>   is fully deterministic, in which case assert it exactly.
> - Prove it is a real regression test: show it failing on the pre-fix code and
>   passing after the fix.
> - Give me one command that runs the whole suite, with a non-zero exit on failure,
>   and save whatever a human needs to eyeball the result.
> - Tell me which assertions are stable and which depend on external variance
>   (network, a model, timing, fonts, the platform), and how the test behaves when
>   those are unavailable.

## Why it generalizes

| In our project | In the general prompt | Why it must be general |
|---|---|---|
| `fixtures/page-320.jpg` | "keep the input that reproduced the bug" | the agent should find the right home for it |
| `fixtures/regression.json` | "propose the smallest structure that fits" | a manifest is right for us, not for everyone |
| `npm run regression -- <id>` | "one command, non-zero exit" | the runner already exists in most repos |
| "the exact region" | "the invariant that was broken" | sub-areas matter here because the unit is a crop |
| "what it must and must not contain" | "assert the invariant, not the literal" | models and readers vary; exact strings are flaky |
| "show the rendered PNG" | "save what a human needs to eyeball" | an image is our artifact, not everyone's |
| "which assertions depend on the reader" | "which depend on external variance" | every project has its own nondeterminism |
| — | "show it failing before the fix" | the step that catches a test that asserts nothing |

The three lines that do the most work are **follow the repo's conventions**, **prove
it fails before the fix**, and **name the nondeterminism**. Without the first the
agent invents a parallel test system; without the second you get a test that passes
on both versions; without the third the suite is flaky in a week.

## Shorter version, when the repo is well organized

> Add a regression test for this fix in the repo's existing test layout: keep the
> input that reproduced the bug, assert the invariant rather than the exact output,
> show it failing before the fix and passing after, and tell me which assertions
> depend on external variance.

## Variants

**Large or non-redistributable input.** Add: *"if the input cannot be committed, write
the case so it can be replayed from a local path, and say what would be needed to make
it self-contained."*

**Model or network in the loop.** Add: *"separate the deterministic part (parsing,
layout, masking) from the nondeterministic part (the call), and test the first without
the network; for the second, record one real response and replay it."*

**No test framework at all.** Add: *"propose the smallest runner that fits, with one
case per bug, and keep it out of the build."*

**Performance or timing bug.** Add: *"assert a ratio against a baseline rather than
wall-clock milliseconds, and say what machine the number came from."*
