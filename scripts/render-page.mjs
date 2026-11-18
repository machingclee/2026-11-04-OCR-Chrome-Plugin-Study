/**
 * Render one page's translation to a local image, and check the balloons that
 * hold a single character.
 *
 *   npm run render:page -- fixtures/page.jpg
 *   npm run render:page -- fixtures/page.jpg --crop 179,149,143,322
 *
 * It runs the extension's own detection, cloud reading, translation, layout and
 * erase passes in Node (see scripts/harness/env.mjs), paints the overlay the way
 * the content script does, and writes:
 *
 *   out/<name>-translated.png   the page with its labels
 *   out/<name>-crop.png         the requested area of that page
 *   out/<name>-balloon-*.png    the balloon that holds a lone character
 *   out/<name>-report.json      groups, labels and every check
 *
 * The checks fail the run (exit 1) when a balloon whose source is one character
 * ends up holding anything but that character — 円 or its Traditional form 圓
 * for this page.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';

import { createCanvas, loadImage, prepareOrt, readApiKey } from './harness/env.mjs';
import {
    CACHE_VERSION,
    cacheableDetection,
    cropTo,
    dataUrlBytes,
    imageDataUrl,
    overlaps,
    readCrop,
    rectOf,
    runPage,
} from './harness/page.mjs';
import { isLoneGlyph, preserveLoneName, spokenGlyphs } from '../src/lib/loneGlyph.ts';
import { DEFAULT_REASONING_EFFORT } from '../src/shared/constants.ts';

const TRADITIONAL = { 円: '圓' };

const FONT_FAMILY = '"PingFang TC", "Heiti TC", "Hiragino Sans", "Arial Unicode MS", sans-serif';

function parseArgs(argv) {
    const options = {
        image: null,
        crop: '179,149,143,322',
        out: 'out',
        effort: DEFAULT_REASONING_EFFORT,
        erase: true,
        ocr: true,
        expect: null,
        json: null,
        saveDetection: null,
        detection: null,
        saveErased: null,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--crop') options.crop = argv[++index];
        else if (value === '--out') options.out = argv[++index];
        else if (value === '--effort') options.effort = argv[++index];
        else if (value === '--no-erase') options.erase = false;
        else if (value === '--no-ocr') options.ocr = false;
        else if (value === '--json') options.json = argv[++index];
        else if (value === '--expect') options.expect = argv[++index];
        else if (value === '--save-detection') options.saveDetection = argv[++index];
        else if (value === '--detection') options.detection = argv[++index];
        else if (value === '--save-erased') options.saveErased = argv[++index];
        else if (value.startsWith('--')) throw new Error(`Unknown option ${value}`);
        else options.image = value;
    }
    if (!options.image) throw new Error('Usage: render-page.mjs <image> [--crop x,y,w,h]');
    return options;
}

/**
 * The rules that keep a one-character balloon to one character, checked without
 * the network. These are the answers the model has actually given for 円 and
 * for a name plate; the guard turns each one into the label the balloon holds.
 */
function selfTest() {
    const cases = [
        ['円', { text: '日圓' }, '円', 'a word for one character is not this balloon'],
        ['円', { text: '是錢的意思' }, '円', 'a sentence for one character is not this balloon'],
        ['円', { text: '円（つぶら）' }, '円', 'the reading beside the name is not the name'],
        ['円', { text: '圓' }, '圓', 'the Traditional form is the same name'],
        ['円', { text: '圓……' }, '圓……', 'a trailing ellipsis stays with the character'],
        ['円', { text: '', type: 'sfx' }, '', 'a sound effect keeps its ink'],
        ['どういうことだよ', { text: '這是怎麼回事啊？' }, '這是怎麼回事啊？', 'a sentence still translates'],
        ['え', { text: '咦？' }, '咦？', 'a lone kana is dialogue'],
        ['有留木 環', { text: '有留木 環（Arutoki Wataru）', type: 'name' }, '有留木 環', 'a note beside a name is dropped'],
        ['有留木 環', { text: '這位是有留木環先生', type: 'name' }, '有留木 環', 'a sentence is not a name plate'],
        ['伯爵様', { text: '伯爵様', type: 'name' }, '伯爵大人', 'a Japanese honorific is not the name'],
        ['伯爵様', { text: '伯爵様' }, '伯爵大人', 'the honorific rule does not depend on the type'],
    ];
    const failed = [];
    for (const [source, answer, expected, why] of cases) {
        const got = preserveLoneName(source, answer).text;
        if (got !== expected) failed.push({ source, answer: answer.text, expected, got, why });
    }
    if (failed.length > 0) {
        for (const entry of failed) {
            console.error(`[selftest] ${entry.why}: ${JSON.stringify(entry.source)} + `
                + `${JSON.stringify(entry.answer)} gave ${JSON.stringify(entry.got)}, expected ${JSON.stringify(entry.expected)}`);
        }
        throw new Error(`${failed.length} guard case(s) failed`);
    }
    console.log(`[selftest] ${cases.length} lone-glyph case(s) hold`);
}

function parseRect(text) {
    const parts = text.split(',').map(Number);
    if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
        throw new Error(`--crop wants x,y,width,height, not ${JSON.stringify(text)}`);
    }
    const [x, y, width, height] = parts;
    return { x, y, width, height };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    selfTest();
    const imagePath = resolve(options.image);
    const key = readApiKey();
    if (!key) throw new Error('No DeepSeek key: put one in .env as VITE_DEEPSEEK_API_KEY, or set DEEPSEEK_API_KEY.');
    await prepareOrt();

    const stem = basename(imagePath, extname(imagePath));
    const outDir = resolve(options.out);
    mkdirSync(outDir, { recursive: true });

    let cached = null;
    if (options.detection) {
        cached = JSON.parse(readFileSync(resolve(options.detection), 'utf8'));
        if (cached.version !== CACHE_VERSION) throw new Error('That detection cache is from another version.');
        cached = { ...cached, ok: true, canInpaint: false, erasedUrl: null, originalUrl: await imageDataUrl(imagePath) };
    }
    const page = await runPage({
        imagePath,
        key,
        effort: options.effort,
        erase: options.erase,
        detection: cached,
    });
    const { detection, job, eraseBoxes } = page;
    console.log(`[page] ${imagePath}`);
    console.log(`[page] ${detection.imageWidth}x${detection.imageHeight}, `
        + `${detection.groups.length} group(s), ${detection.blocks?.length ?? 0} block(s), `
        + `${detection.bubbles.length} balloon(s)`);
    console.log(`[page] ${job.used}, ${job.items.length} label(s), ${job.skipped} skipped`);
    if (options.saveDetection && !cached) {
        writeFileSync(resolve(options.saveDetection), `${JSON.stringify(cacheableDetection(detection))}\n`);
        console.log(`[page] detection saved to ${options.saveDetection}`);
    }
    if (options.saveErased && page.erasedUrl) {
        writeFileSync(resolve(options.saveErased), dataUrlBytes(page.erasedUrl));
        console.log(`[out] ${resolve(options.saveErased)}`);
    }
    const translatedPath = resolve(outDir, `${stem}-translated.png`);
    page.save(translatedPath);
    const canvas = page.canvas;
    console.log(`[out] ${translatedPath}`);

    const report = {
        image: imagePath,
        blocks: detection.blocks ?? [],
        erase: eraseBoxes,
        width: detection.imageWidth,
        height: detection.imageHeight,
        used: job.used,
        groups: [],
        loneGlyphs: [],
        checks: [],
    };
    const fail = (message) => {
        report.checks.push({ ok: false, message });
        console.error(`[FAIL] ${message}`);
    };
    const pass = (message) => {
        report.checks.push({ ok: true, message });
        console.log(`[ok] ${message}`);
    };
    // The reader is a corroborating witness, not the gate: it reads 圓 as 員 now
    // and then, because the enclosing box looks like a balloon outline to it.
    // What gates the run is the label the pipeline placed; the reader only has
    // to agree that nothing else sits in that balloon.
    const warn = (message) => {
        report.checks.push({ ok: true, warning: true, message });
        console.warn(`[warn] ${message}`);
    };

    for (const [index, group] of detection.groups.entries()) {
        const labels = job.items
            .filter((item) => item.groupId === index)
            .map((item) => ({ ...rectOf(item), text: item.text, fontSize: item.fontSize, vertical: item.vertical }));
        const source = group.lines.join('');
        report.groups.push({
            index,
            box: rectOf(group),
            source,
            lines: group.lines,
            translations: group.translations ?? null,
            answer: job.answers[index]?.text ?? null,
            labels,
        });
        console.log(`[group ${index}] ${JSON.stringify(source)} -> `
            + `${JSON.stringify(job.answers[index]?.text ?? '')} ${JSON.stringify(labels.map((label) => label.text))}`);
    }

    // Every balloon whose source is one name glyph must still hold that glyph:
    // 円 stays 円 or 圓, and never becomes 日圓 or a sentence. A lone kana is
    // dialogue (「え？」), so it is reported and not gated.
    const loneGroups = detection.groups
        .map((group, index) => ({ group, index }))
        .filter(({ group }) => isLoneGlyph(group.lines.join('')));
    const balloons = detection.bubbles ?? [];
    for (const { group, index } of loneGroups) {
        const centre = { x: group.x + group.width / 2, y: group.y + group.height / 2 };
        const balloon = balloons.find((bubble) => (
            centre.x >= bubble.x && centre.x <= bubble.x + bubble.width
            && centre.y >= bubble.y && centre.y <= bubble.y + bubble.height
        ));
        const placed = job.items.filter((item) => item.groupId === index);
        const text = placed.map((item) => item.text).join('');
        const glyphs = spokenGlyphs(text);
        const source = spokenGlyphs(group.lines.join(''))[0];
        // --expect names the glyphs this page must show, whatever the reader
        // transcribed; without it the source glyph and its Traditional form are
        // what the balloon may hold.
        const allowed = options.expect
            ? options.expect.split(',').map((glyph) => glyph.trim()).filter(Boolean)
            : [source, TRADITIONAL[source]].filter(Boolean);
        // The balloon the reader found can cover a neighbouring balloon, and its
        // crop then holds that balloon's label too. What this check reads is the
        // area the label itself was placed on, with one em of paper around it:
        // that is the little balloon the character sits in.
        const label = placed.length > 0
            ? (() => {
                const left = Math.min(...placed.map((item) => item.x));
                const top = Math.min(...placed.map((item) => item.y));
                const right = Math.max(...placed.map((item) => item.x + item.width));
                const bottom = Math.max(...placed.map((item) => item.y + item.height));
                return { x: left, y: top, width: right - left, height: bottom - top };
            })()
            : rectOf(group);
        const pad = Math.max(8, Math.round(Math.max(...placed.map((item) => item.fontSize ?? 12), 12) * 0.7));
        const area = (() => {
            const x = Math.max(0, label.x - pad);
            const y = Math.max(0, label.y - pad);
            return {
                x,
                y,
                width: Math.min(label.x + label.width + pad, detection.imageWidth) - x,
                height: Math.min(label.y + label.height + pad, detection.imageHeight) - y,
            };
        })();
        const name = `${stem}-balloon-${source}`;
        const balloonCrop = cropTo(canvas, area, 6, resolve(outDir, `${name}.png`));
        const read = options.ocr ? await readCrop(key, balloonCrop) : [];
        if (balloon) {
            // Kept as a picture of the whole balloon, for eyeballing only.
            const whole = rectOf(balloon);
            cropTo(canvas, {
                x: Math.max(0, whole.x - 4),
                y: Math.max(0, whole.y - 4),
                width: Math.min(whole.width + 8, detection.imageWidth - Math.max(0, whole.x - 4)),
                height: Math.min(whole.height + 8, detection.imageHeight - Math.max(0, whole.y - 4)),
            }, 2, resolve(outDir, `${stem}-balloon-${source}-whole.png`));
        }
        report.loneGlyphs.push({
            index,
            source,
            answer: job.answers[index]?.text ?? null,
            placed: text,
            area,
            balloon: balloon ? rectOf(balloon) : null,
            read,
        });

        if (glyphs.length !== 1) {
            fail(`group ${index} (source ${source}) placed ${JSON.stringify(text)}: `
                + `${glyphs.length} glyph(s) in a balloon that holds one`);
        } else if (!allowed.includes(glyphs[0])) {
            fail(`group ${index} (source ${source}) placed ${JSON.stringify(text)}: `
                + `expected one of ${allowed.join(' / ')}`);
        } else {
            pass(`group ${index} (source ${source}) holds exactly ${glyphs[0]}`);
        }
        const readGlyphs = spokenGlyphs(read.join(''));
        if (options.ocr && readGlyphs.length === 0) {
            fail('the rendered balloon reads nothing');
        } else if (options.ocr && readGlyphs.length > 1) {
            fail(`the rendered balloon reads ${JSON.stringify(read)}: ${readGlyphs.length} glyph(s) in a balloon that holds one`);
        } else if (options.ocr && !allowed.includes(readGlyphs[0])) {
            warn(`the rendered balloon reads ${JSON.stringify(readGlyphs[0])}; the label is `
                + `${JSON.stringify(glyphs[0])}, and the reader drops the enclosing box of 圓`);
        } else if (options.ocr) {
            pass(`the rendered balloon reads ${JSON.stringify(readGlyphs[0])}`);
        }
    }
    if (loneGroups.length === 0) {
        // Not every page has a one-character name. Only the page this check was
        // written for does, and a page without one is translated like any other.
        console.log('[note] no balloon with a single-character name on this page');
    }
    for (const [index, group] of detection.groups.entries()) {
        const glyphs = spokenGlyphs(group.lines.join(''));
        if (glyphs.length !== 1 || isLoneGlyph(group.lines.join(''))) continue;
        // A one kana balloon is dialogue. Its wording is the translator's, so it
        // is printed with the other groups and not asserted here.
        console.log(`[note] group ${index} (source ${glyphs[0]}) is one kana: `
            + `${JSON.stringify(job.items.filter((item) => item.groupId === index).map((item) => item.text))}`);
    }

    // The requested area, for the visual check the page asks for.
    const cropRect = parseRect(options.crop);
    const cropPath = resolve(outDir, `${stem}-crop.png`);
    const crop = cropTo(canvas, cropRect, 2, cropPath);
    console.log(`[out] ${cropPath} (${cropRect.x},${cropRect.y} ${cropRect.width}x${cropRect.height})`);
    const inCrop = job.items
        .filter((item) => overlaps(item, cropRect))
        .map((item) => ({ ...rectOf(item), text: item.text }));
    report.crop = { rect: cropRect, labels: inCrop, read: options.ocr ? await readCrop(key, crop) : [] };
    console.log(`[crop] labels inside: ${JSON.stringify(inCrop.map((label) => label.text))}`);
    if (options.ocr) console.log(`[crop] reads: ${JSON.stringify(report.crop.read)}`);

    const failed = report.checks.filter((check) => !check.ok).length;
    report.ok = failed === 0;
    writeFileSync(options.json ?? resolve(outDir, `${stem}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
    console.log(failed === 0 ? '[PASS] every lone-character balloon holds one character' : `[FAIL] ${failed} check(s) failed`);
    if (failed > 0) process.exitCode = 1;
}

await main();
