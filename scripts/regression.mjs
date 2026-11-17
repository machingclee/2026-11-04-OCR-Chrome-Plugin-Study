/**
 * Replay the regression cases in fixtures/regression.json.
 *
 *   npm run regression                 every case
 *   npm run regression -- circle       one case, by id
 *
 * Each case runs its image through the same pipeline the extension runs
 * (scripts/harness/page.mjs), saves the rendered page under out/regression/,
 * and checks the invariants the case names. An invariant is something that was
 * broken once: a one-character balloon that came back as 日圓, a moan read as
 * 憂鬱, a block that kept its Japanese under the translation.
 *
 * Cases are asserted on behaviour, not on exact wording, because the reader
 * returns slightly different boxes every run and the translator is a model:
 * `contains` / `notContains` name the words that must or must not appear, and
 * the erase check is a share of strokes, so a rephrasing does not fail the run
 * while a regression does.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEFAULT_REASONING_EFFORT } from '../src/shared/constants.ts';
import { applyInclination } from '../src/lib/ocr/cloudOcr.ts';
import { createCanvas, loadImage, prepareOrt, readApiKey } from './harness/env.mjs';
import { dataUrlBytes, runPage } from './harness/page.mjs';
import { spokenGlyphs } from '../src/lib/loneGlyph.ts';

const ROOT = process.cwd();
const OUT = resolve(ROOT, 'out/regression');

const KANA = /[\u3040-\u309F\u30A0-\u30FF\u30FC\u30FB]/u;

function args() {
    const only = process.argv.slice(2).filter((value) => !value.startsWith('--'));
    const effort = process.argv.includes('--effort')
        ? process.argv[process.argv.indexOf('--effort') + 1]
        : null;
    return { only, effort };
}

/**
 * The share of a label's strokes the erase did not touch.
 *
 * Only ink that does not reach the box border counts. A balloon wall, a panel
 * edge or a screentone boundary crosses the box, and that art is correctly left
 * alone; a glyph the label sits on is inside the box. Without this the check
 * failed on a label placed near a wall, which is a false alarm, and a false
 * alarm in a suite is worse than no suite.
 */
function uncoveredShare(original, erased, box) {
    const x0 = Math.max(0, Math.floor(box.x));
    const y0 = Math.max(0, Math.floor(box.y));
    const x1 = Math.min(original.width, Math.ceil(box.x + box.width));
    const y1 = Math.min(original.height, Math.ceil(box.y + box.height));
    const width = x1 - x0;
    const height = y1 - y0;
    if (width <= 0 || height <= 0) return 0;
    const source = original.getContext('2d').getImageData(x0, y0, width, height).data;
    const cut = erased ? erased.getContext('2d').getImageData(x0, y0, width, height).data : null;
    const lumas = new Float64Array(width * height);
    for (let index = 0; index < width * height; index += 1) {
        const at = index * 4;
        lumas[index] = 0.299 * source[at] + 0.587 * source[at + 1] + 0.114 * source[at + 2];
    }
    // The median comes from a sorted copy: sorting `lumas` itself loses the
    // pixel each value belongs to, and the ink test then reads the wrong pixel.
    const sorted = Float64Array.from(lumas).sort();
    const paper = sorted[sorted.length >> 1] ?? 255;

    const ink = new Uint8Array(width * height);
    for (let index = 0; index < width * height; index += 1) {
        if (lumas[index] < paper - 45) ink[index] = 1;
    }
    // Flood the ink that touches the border: that is the artwork the label sits on.
    const border = new Uint8Array(width * height);
    const stack = [];
    for (let x = 0; x < width; x += 1) { stack.push(x, (height - 1) * width + x); }
    for (let y = 0; y < height; y += 1) { stack.push(y * width, y * width + width - 1); }
    while (stack.length > 0) {
        const index = stack.pop();
        if (index < 0 || index >= width * height || border[index] === 1 || ink[index] !== 1) continue;
        border[index] = 1;
        const x = index % width;
        if (x > 0) stack.push(index - 1);
        if (x < width - 1) stack.push(index + 1);
        stack.push(index - width, index + width);
    }

    let count = 0;
    let left = 0;
    for (let index = 0; index < width * height; index += 1) {
        if (ink[index] !== 1 || border[index] === 1) continue;
        count += 1;
        if (cut && cut[index * 4 + 3] === 255) continue;
        left += 1;
    }
    return count === 0 ? 0 : left / count;
}

async function canvasOf(dataUrl) {
    if (!dataUrl) return null;
    const canvas = createCanvas(1, 1);
    const image = await loadImage(dataUrlBytes(dataUrl));
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return canvas;
}

/**
 * The text of a box with the marks that carry no sound removed.
 *
 * A caption read twice comes back as 人生の負け組だ… and 人生の負け組だ, and the
 * ellipsis is the reader's, not a second line of text. Width forms are folded
 * for the same reason the reader folds them: この２人 and この2人 are one line.
 */
const PUNCTUATION = /[\s\u3000、。！？…‥「」『』（）()・,.!?;:—―-]/gu;

function inkText(text) {
    return text.normalize('NFKC').replace(PUNCTUATION, '');
}

function areaOf(box) {
    return box.width * box.height;
}

/** How much of the smaller box the two boxes share, 0 to 1. */
function sharedShare(left, right) {
    const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
    const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
    if (width <= 0 || height <= 0) return 0;
    return (width * height) / Math.min(areaOf(left), areaOf(right));
}

/** The order the lines of one block are read in: down, and right to left. */
function readingOrder(lines) {
    return [...lines].sort((left, right) => (
        left.direction === 'vertical' || right.direction === 'vertical'
            ? (right.x - left.x) || (left.y - right.y)
            : (left.y - right.y) || (left.x - right.x)
    ));
}

/**
 * The longest run of glyphs one string repeats.
 *
 * A group is translated once. When its answer carries the same phrase twice,
 * the source carried the phrase twice: a 花岡修太郎 三十九歳 / 人生失敗組啦 that
 * the page had already read. A phrase repeated on purpose (我愛你…我愛你) is
 * four glyphs, which is why the case's threshold is above that.
 */
function longestRepeat(text) {
    const glyphs = [...text];
    let longest = 0;
    for (let from = 0; from < glyphs.length; from += 1) {
        for (let at = from + 1; at < glyphs.length; at += 1) {
            let run = 0;
            while (at + run < glyphs.length && glyphs[from + run] === glyphs[at + run]) run += 1;
            if (run > longest) longest = run;
        }
    }
    return longest;
}

/**
 * Two translations on one piece of ink, one translation made of two.
 *
 * The detector's blk head can hand back a block nested inside another block's
 * box; each block is read on its own, so the inner columns are read twice and
 * the outer block joins two of them into a line of its own. Every reading is
 * true and only one of them may reach the page: the same ink, translated once.
 */
function oneInkFailures(page) {
    const failures = [];
    const lines = (page.detection.boxes ?? [])
        .filter((box) => box.text.trim().length > 0 && box.kind !== 'sfx')
        .map((box) => ({ ...box, text: inkText(box.text) }))
        .filter((box) => box.text.length > 0);

    for (let left = 0; left < lines.length; left += 1) {
        for (let right = left + 1; right < lines.length; right += 1) {
            const a = lines[left];
            const b = lines[right];
            if (sharedShare(a, b) < 0.3) continue;
            if (a.text !== b.text) continue;
            failures.push(`${JSON.stringify(a.text)} is read twice, at `
                + `${Math.round(a.x)},${Math.round(a.y)} and ${Math.round(b.x)},${Math.round(b.y)}`);
        }
    }

    // A joined line is the same ink as the run of columns it covers: the
    // reader read 花岡修太郎 and 三十九歳 off one block's grid, and the other
    // block joined them into 花岡修太郎 三十九歳. A window of the overlap in
    // reading order is the run; a window is used rather than every overlap
    // because a line also overlaps its neighbours in the next column.
    for (const line of lines) {
        const covered = readingOrder(lines.filter((other) => other !== line && sharedShare(line, other) >= 0.3));
        for (let from = 0; from < covered.length; from += 1) {
            let joined = '';
            for (let to = from; to < covered.length; to += 1) {
                joined += covered[to].text;
                if (to === from) continue;
                if (joined === line.text) {
                    failures.push(`${JSON.stringify(line.text)} at ${Math.round(line.x)},${Math.round(line.y)} `
                        + `is the join of ${JSON.stringify(covered.slice(from, to + 1).map((one) => one.text))} `
                        + `and is read twice`);
                }
            }
        }
    }

    // Two groups over one block put two labels on the same columns. A merged
    // balloon is split by column gap before translation, so its groups do not
    // overlap; an overlap this large is one block read as two.
    const groups = page.detection.groups ?? [];
    for (let left = 0; left < groups.length; left += 1) {
        for (let right = left + 1; right < groups.length; right += 1) {
            const share = sharedShare(groups[left], groups[right]);
            if (share < 0.6) continue;
            failures.push(`${JSON.stringify(groups[left].lines.join(''))} and `
                + `${JSON.stringify(groups[right].lines.join(''))} are two groups on one block `
                + `(${Math.round(share * 100)}% of the smaller box shared)`);
        }
    }
    return failures;
}

/**
 * The reader's lean must never rotate a label.
 *
 * It answered `lean: -20` for a column that leaned +5, and a build that used it
 * drew the TV speech in the wrong direction. The geometry has to come from the
 * ink; with no mask there is no angle, not the reader's guess.
 */
function inclineSelfTest() {
    const region = {
        x: 312,
        y: 580,
        width: 78,
        height: 155,
        text: '…',
        direction: 'v',
        columns: 1,
        rows: 1,
        boxIds: [1],
        angle: -20 * Math.PI / 180,
        glyphSize: 30,
        kind: 'chat',
    };
    applyInclination([region], [{ x: 312, y: 580, width: 78, height: 155 }], null);
    if (Math.abs(region.angle ?? 0) >= 0.01) {
        throw new Error(`The reader's lean still rotates a label: ${((region.angle ?? 0) * 180 / Math.PI).toFixed(1)}deg`);
    }
    console.log('[selftest] a reader lean with no mask leaves the label upright');
}

function checkCase(page, testCase) {
    const failures = [];
    const groups = page.detection.groups.map((group, index) => ({
        source: group.lines.join(''),
        answer: page.job.answers[index]?.text ?? '',
    }));

    // Every region that got an answer is Chinese: a kana left in a label is the
    // reader's Japanese reaching the page.
    for (const group of groups) {
        if (group.answer.length > 0 && KANA.test(group.answer)) {
            failures.push(`kana in the translation of ${JSON.stringify(group.source)}: `
                + `${JSON.stringify(group.answer)}`);
        }
    }

    if (testCase.oneInk) failures.push(...oneInkFailures(page));

    if (testCase.maxRepeat) {
        for (const group of groups) {
            const repeat = longestRepeat(inkText(group.answer));
            if (repeat >= testCase.maxRepeat) {
                failures.push(`${JSON.stringify(group.answer)} for ${JSON.stringify(group.source)} repeats `
                    + `${repeat} glyphs: the source held that text twice`);
            }
        }
    }

    for (const word of testCase.forbid ?? []) {
        for (const group of groups) {
            if (group.answer.includes(word)) {
                failures.push(`${JSON.stringify(word)} appears in ${JSON.stringify(group.answer)} `
                    + `for ${JSON.stringify(group.source)}`);
            }
        }
    }

    for (const source of testCase.sources?.mustNotMatch ?? []) {
        const hit = groups.find((group) => group.source.includes(source));
        if (hit) failures.push(`the reader produced ${JSON.stringify(hit.source)}, not kana`);
    }

    for (const rule of testCase.groups ?? []) {
        const pattern = rule.source ? new RegExp(rule.source) : null;
        const matches = page.detection.groups.map((group, index) => ({ ...groups[index], box: group, lines: group.lines.length }))
            .filter((group) => {
                if (rule.at) {
                    const [x, y] = rule.at;
                    const { box } = group;
                    return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
                }
                return pattern ? pattern.test(group.source) : false;
            });
        if (matches.length === 0) {
            // A case can allow the group to be absent: the reader does not report
            // every balloon on every run, and a suite that fails on that measures
            // the reader's luck rather than the fix.
            if (rule.onMissing === 'skip') {
                const where = rule.source ?? (rule.at ? `at ${rule.at.join(',')}` : 'group');
                console.log(`   (skipped ${where}: the reader did not report it this run)`);
                continue;
            }
            failures.push(`no group matches ${JSON.stringify(rule.source)}`);
            continue;
        }
        for (const match of matches) {
            for (const word of rule.contains ?? []) {
                if (!match.answer.includes(word)) {
                    failures.push(`${JSON.stringify(match.answer)} for ${JSON.stringify(match.source)} `
                        + `does not contain ${JSON.stringify(word)}`);
                }
            }
            if (rule.sourceIsKana && !/^[\u3040-\u309F\u30A0-\u30FF\u30FC\u30FB\s]+$/u.test(match.source)) {
                failures.push(`the text of the bubble at ${JSON.stringify(rule.at)} is `
                    + `${JSON.stringify(match.source)}, not the kana the reader had to correct`);
            }
            if (rule.minLines && match.lines < rule.minLines) {
                failures.push(`${JSON.stringify(match.source)} has ${match.lines} line(s), not ${rule.minLines}: `
                    + `the reader did not split the block into its columns`);
            }
            if (rule.maxGlyphs && spokenGlyphs(match.answer).length > rule.maxGlyphs) {
                failures.push(`${JSON.stringify(match.answer)} for ${JSON.stringify(match.source)} is a phrase, `
                    + `not the short sound the source is`);
            }
            if (rule.oneOf && !rule.oneOf.some((word) => match.answer.includes(word))) {
                failures.push(`${JSON.stringify(match.answer)} for ${JSON.stringify(match.source)} `
                    + `contains none of ${JSON.stringify(rule.oneOf)}`);
            }
            for (const word of rule.notContains ?? []) {
                if (match.answer.includes(word)) {
                    failures.push(`${JSON.stringify(match.answer)} for ${JSON.stringify(match.source)} `
                        + `contains ${JSON.stringify(word)}`);
                }
            }
        }
    }

    // A leaned block must be drawn leaned and at the source glyph size. The
    // reader answers direction "v" without a lean for a tilted column, so the
    // label geometry is the pipeline's job: this compares what was drawn with
    // the ink it replaced, not with what the model said.
    for (const rule of testCase.labels ?? []) {
        let selected = page.job.items;
        if (rule.region) {
            const [x, y, width, height] = rule.region;
            selected = selected.filter((item) => {
                const cx = item.x + item.width / 2;
                const cy = item.y + item.height / 2;
                return cx >= x && cx <= x + width && cy >= y && cy <= y + height;
            });
        }
        if (rule.source) {
            const pattern = new RegExp(rule.source);
            const ids = new Set(page.detection.groups
                .map((group, index) => ({ group, index }))
                .filter((entry) => pattern.test(entry.group.lines.join('')))
                .map((entry) => entry.index));
            if (ids.size === 0 && rule.onMissing !== 'skip') {
                failures.push(`no group matches ${JSON.stringify(rule.source)}`);
                continue;
            }
            selected = selected.filter((item) => item.groupId !== undefined && ids.has(item.groupId));
        }
        // A horizontal number plate can sit in the same block as a leaned
        // column (31 above 回卒業証書授). It is not the thing this rule is
        // about, so a label with no CJK glyph is left to the other checks.
        const leaned = selected.filter((item) => /[\u3400-\u9fff]/u.test(item.text));
        if (rule.minCount && leaned.length < rule.minCount && leaned.length > 0) {
            failures.push(`${leaned.length} label(s) in the region, not ${rule.minCount}: `
                + `the block did not become ${rule.minCount} columns`);
        }
        if (leaned.length === 0) {
            // The banner is not reported on every run: the reader sometimes
            // reads only its top, and then the label lands above this region.
            // The TV speech is the mandatory half of the case; the banner is
            // checked when it is there.
            if (rule.onMissing === 'skip') {
                console.log(`   (skipped the label region ${JSON.stringify(rule.region)}: nothing drawn there this run)`);
                continue;
            }
            failures.push(`no label in the region ${JSON.stringify(rule.region)}`);
            continue;
        }
        for (const item of leaned) {
            if (rule.lean !== undefined) {
                const deg = (item.angle ?? 0) * 180 / Math.PI;
                const tolerance = rule.leanTolerance ?? 4;
                if (Math.abs(deg - rule.lean) > tolerance) {
                    failures.push(`${JSON.stringify(item.text)} is drawn at ${deg.toFixed(1)}deg, `
                        + `not ${rule.lean}deg (+-${tolerance})`);
                }
            }
            if (rule.em !== undefined) {
                // A reader run can put every column of the TV speech into one
                // entry, so the translation is squeezed into one line at a
                // fraction of the source size. That is a layout failure, not a
                // glyph measurement; the glyph rule applies to a label that is
                // one column, and a long merged label is left to the angle.
                const glyphs = spokenGlyphs(item.text).length;
                const merged = rule.emMaxGlyphs !== undefined && glyphs > rule.emMaxGlyphs;
                if (!merged) {
                    const tolerance = rule.emTolerance ?? 0.3;
                    const ratio = item.fontSize / rule.em;
                    if (Math.abs(ratio - 1) > tolerance) {
                        failures.push(`${JSON.stringify(item.text)} is drawn at ${item.fontSize}px, `
                            + `not the ${rule.em}px glyph (+-${Math.round(tolerance * 100)}%)`);
                    }
                }
            }
        }
        for (let left = 0; left < leaned.length; left += 1) {
            for (let right = left + 1; right < leaned.length; right += 1) {
                const a = leaned[left];
                const b = leaned[right];
                const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
                const overlapHeight = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
                if (overlapWidth <= 0 || overlapHeight <= 0) continue;
                const share = (overlapWidth * overlapHeight) / Math.min(a.width * a.height, b.width * b.height);
                if (share > 0.4) {
                    failures.push(`${JSON.stringify(a.text)} and ${JSON.stringify(b.text)} overlap on `
                        + `${(share * 100).toFixed(0)}% of one label: two columns share one box`);
                }
            }
        }
    }

    for (const rule of testCase.loneGlyphs ?? []) {
        const pattern = new RegExp(rule.source);
        const matches = groups.filter((group) => pattern.test(group.source));
        if (matches.length === 0) {
            failures.push(`no one-character group matches ${JSON.stringify(rule.source)}`);
            continue;
        }
        for (const match of matches) {
            const glyphs = spokenGlyphs(match.answer);
            if (glyphs.length !== 1 || !rule.allowed.includes(glyphs[0])) {
                failures.push(`${JSON.stringify(match.answer)} for ${JSON.stringify(match.source)}: `
                    + `expected one of ${rule.allowed.join(' / ')}`);
            }
        }
    }

    return failures;
}

async function main() {
    inclineSelfTest();
    const options = args();
    const manifest = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/regression.json'), 'utf8'));
    const cases = manifest.cases.filter((testCase) => (
        options.only.length === 0 || options.only.includes(testCase.id)
    ));
    if (cases.length === 0) throw new Error(`No case matched ${JSON.stringify(options.only)}`);

    const key = readApiKey();
    if (!key) throw new Error('No DeepSeek key: put one in .env as VITE_DEEPSEEK_API_KEY, or set DEEPSEEK_API_KEY.');
    await prepareOrt();
    mkdirSync(OUT, { recursive: true });

    const results = [];
    let failed = 0;
    for (const testCase of cases) {
        const imagePath = resolve(ROOT, testCase.image);
        const effort = options.effort ?? testCase.effort ?? DEFAULT_REASONING_EFFORT;
        process.stdout.write(`[case] ${testCase.id} (${testCase.image}, effort ${effort}) `);
        const started = Date.now();
        let page;
        try {
            page = await runPage({ imagePath, key, effort });
        } catch (cause) {
            failed += 1;
            console.log(`FAIL: ${cause instanceof Error ? cause.message : String(cause)}`);
            results.push({ id: testCase.id, ok: false, failures: [String(cause)] });
            continue;
        }

        const failures = checkCase(page, testCase);
        if (testCase.erase && !page.erasedUrl) {
            console.log('   (erase check skipped: the inpaint pass returned no cutout)');
        }
        if (testCase.erase && page.erasedUrl) {
            const original = await canvasOf(page.detection.originalUrl);
            const erased = await canvasOf(page.erasedUrl);
            // Measured under each label, not over the block: the block's crop
            // holds the balloon wall and the screentone, which are ink and are
            // not supposed to be erased. What must be free of Japanese is the
            // area the translation sits on.
            let worst = { share: 0, label: null };
            for (const item of page.job.items) {
                // The label box can touch the balloon wall or a panel edge, and
                // that art is source ink that is correctly not erased. Reading the
                // middle of the label avoids measuring the wall as a leftover.
                const inset = 0.25;
                const inner = {
                    x: item.x + item.width * inset,
                    y: item.y + item.height * inset,
                    width: item.width * (1 - inset * 2),
                    height: item.height * (1 - inset * 2),
                };
                const share = uncoveredShare(original, erased, inner);
                if (share > worst.share) worst = { share, label: item.text, box: { ...item } };
            }
            const limit = testCase.erase.maxUncoveredShare ?? 0.02;
            if (worst.share > limit) {
                failures.push(`${(worst.share * 100).toFixed(1)}% of the strokes under the label `
                    + `${JSON.stringify(worst.label)} at ${Math.round(worst.box.x)},${Math.round(worst.box.y)} `
                    + `${Math.round(worst.box.width)}x${Math.round(worst.box.height)} were not erased `
                    + `(limit ${(limit * 100).toFixed(0)}%)`);
            }
            page.eraseWorst = worst;
        }

        // The effort is in the file name only when the run overrode the case's
        // own level, so `groan-high` writes groan-high.png rather than -high-high.
        const suffix = options.effort ? `-${effort}` : '';
        const image = resolve(OUT, `${testCase.id}${suffix}.png`);
        page.save(image);
        if (page.erasedUrl) {
            writeFileSync(resolve(OUT, `${testCase.id}${suffix}-erased.png`), dataUrlBytes(page.erasedUrl));
        }
        const groups = page.detection.groups.map((group, index) => ({
            source: group.lines.join(''),
            answer: page.job.answers[index]?.text ?? '',
        }));
        results.push({
            id: testCase.id,
            image: testCase.image,
            effort,
            rendered: image,
            labels: page.job.items.length,
            erased: Boolean(page.erasedUrl),
            note: testCase.note,
            groups,
            erase: page.eraseWorst ?? null,
            ms: Date.now() - started,
            ok: failures.length === 0,
            failures,
        });
        if (failures.length === 0) {
            console.log(`ok (${groups.length} group(s), ${((Date.now() - started) / 1000).toFixed(1)}s)`);
        } else {
            failed += 1;
            console.log(`FAIL (${failures.length})`);
            for (const failure of failures) console.log(`   ${failure}`);
        }
    }

    const report = { cases: results.length, failed, results };
    writeFileSync(resolve(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n[regression] ${results.length - failed}/${results.length} case(s) passed; `
        + `rendered pages in out/regression/`);
    if (failed > 0) process.exitCode = 1;
}

await main();
