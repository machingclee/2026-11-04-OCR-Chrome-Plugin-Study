---
name: bump-version
description: >-
  Bump the Comic Translator extension version to a new semver number. Updates the
  three places the version lives — package.json, public/manifest.json, and the
  popup header badge in src/App.tsx — then creates the annotated git tag. Use when
  asked to bump or dump the version, cut or tag a release, update the version
  number, set the app version to X.Y.Z, or when a version bump is implied by a
  release task.
---

# Bump the extension version

The version lives in three places and all three must agree:

| Location | Form |
|---|---|
| `package.json` → `version` | `1.2.0` — no `v` |
| `public/manifest.json` → `version` | `1.2.0` — no `v`; Chrome takes 1–4 dot-separated integers |
| `src/App.tsx` → popup header badge | `v1.2.0` — the `<span>` carrying `text-[#7a5c43]` |

Git tags carry the `v` prefix: `v1.2.0`.

## 0. Look before touching

```bash
grep -m1 '"version"' package.json public/manifest.json
grep -n 'text-\[#7a5c43\]' src/App.tsx
git describe --tags --abbrev=0
```

These have drifted before: the files once read `0.5.0` while the badge read `v1.0.5` and tags reached `v1.1.0`. If they disagree, mention it in one line and move on — derive the next version from tag history, do not rewrite history or "fix" old tags.

## 1. Resolve the number

- Explicit number given → use it verbatim.
- "bump the version" with no number → patch bump from the newest `v*` tag (`v1.1.0` → `v1.1.1`), and say which one you chose.
- Genuinely ambiguous between major and minor → ask; don't guess.
- Confirm the tag is free before proceeding: `git tag --list v1.2.0` (empty output = free).
- Never reuse, move, or delete an existing tag.

## 2. Update the two JSON files

```bash
V=1.2.0
node -e '
const fs = require("fs");
const v = process.argv[1];
for (const f of ["package.json", "public/manifest.json"]) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.version = v;
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
}
' "$V"
```

## 3. Update the displayed version

Edit the single `<span>` in `src/App.tsx` that carries `text-[#7a5c43]`, replacing the badge text with `v$V`. Keep the className untouched — only the text inside the `<span>` changes.

Then confirm nothing else hardcodes a version:

```bash
grep -rn 'v[0-9]\+\.[0-9]\+\.[0-9]\+' src/ --include=*.tsx --include=*.ts
```

## 4. Verify all three agree

```bash
grep -m1 '"version"' package.json public/manifest.json
grep -o 'v[0-9]\+\.[0-9]\+\.[0-9]\+' src/App.tsx
npm run typecheck
```

All three lines must show the same number (file values without `v`, badge with). If typecheck fails for reasons unrelated to the version, say so rather than silently reverting.

## 5. Commit and tag

```bash
git add package.json public/manifest.json src/App.tsx
git commit -m "Bump version to $V"
git tag -a "v$V" -m "Comic translator v$V"
```

Use an annotated tag (`-a`) — every existing tag in this repo is annotated, with subject `Comic translator vX.Y.Z`. Match that style.

Leave the commit and tag local unless asked to push. Do not push a tag that was not requested.

## 6. Report

State: old version → new version, the three files changed, the tag created, and that nothing was pushed.

## Gotchas

- `dist/` and `out/` are gitignored build output — never edit a version in there.
- `dist.zip` **is tracked** and is roughly 160 MB. Do not rebuild or re-`git add` it as part of a version bump unless explicitly asked; it would swamp the commit.
- `opus-v0.0.1` is an unrelated experiment tag. Ignore it when deriving the next version.
- Chrome rejects versions with more than four parts, leading zeros, or non-numeric segments. Keep it plain `X.Y.Z`.
- Bumping the version does not bump `DETECTION_CACHE_VERSION` in `src/background/index.ts` — that cache key is separate and versioned on its own.
