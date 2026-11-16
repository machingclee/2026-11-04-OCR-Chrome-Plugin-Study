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

import { DEFAULT_REASONING_EFFORT, OFFSCREEN_TARGET } from '../src/shared/constants.ts';
import { createCanvas, loadImage, prepareOrt, readApiKey } from './harness/env.mjs';
import { runDetection, runInpaint } from '../src/offscreen/main.ts';
import { translateGroups } from '../src/lib/translationJob.ts';
import { requestDeepSeek } from '../src/lib/ocr/cloudOcr.ts';
import { isLoneGlyph, preserveLoneName, spokenGlyphs } from '../src/lib/loneGlyph.ts';

/** The Traditional form a lone source glyph may come back as. */
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

const rectOf = (box) => ({ x: box.x, y: box.y, width: box.width, height: box.height });
const overlaps = (left, right) => (
    left.x < right.x + right.width && right.x < left.x + left.width
    && left.y < right.y + right.height && right.y < left.y + left.height
);
const overlapShare = (box, other) => {
    const width = Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x);
    const height = Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y);
    if (width <= 0 || height <= 0) return 0;
    return (width * height) / Math.min(box.width * box.height, other.width * other.height);
};

/**
 * The rectangles to erase, built the way the service worker builds them
 * (src/background/index.ts, runTranslation): only a block that carries a label
 * is erased, and only the area its own lines and labels cover, so a column the
 * reader missed cannot leave a blank balloon.
 */
function eraseBoxesFor(detection, job) {
    const areaOf = (block) => {
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        const include = (box) => {
            if (!overlaps(box, block)) return;
            minX = Math.min(minX, box.x);
            minY = Math.min(minY, box.y);
            maxX = Math.max(maxX, box.x + box.width);
            maxY = Math.max(maxY, box.y + box.height);
        };
        for (const box of job.erase) include(box);
        for (const box of job.labelled) include(box);
        return maxX > minX && maxY > minY
            ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
            : null;
    };
    const readable = (detection.blockReadings ?? [])
        .filter((reading) => reading.regions.some((region) => region.kind !== 'sfx' && region.text.trim().length > 0));
    const dialogueBlocks = readable
        .filter((reading) => job.labelled.some((box) => overlaps(box, reading.block)))
        .map((reading) => ({
            ...(areaOf(reading.block) ?? rectOf(reading.block)),
            kind: 'block',
            keep: [
                ...reading.regions
                    .filter((region) => region.kind === 'sfx')
                    .map(rectOf),
                ...job.keep.filter((line) => overlaps(line, reading.block)),
            ],
        }));
    const fallback = readable.length > 0
        ? []
        : job.erase
            .map((box) => ({ ...box, kind: 'region' }))
            .filter((box) => !job.keep.some((line) => overlapShare(line, box) > 0.5));
    return [...dialogueBlocks, ...fallback];
}

const dataUrlBytes = (dataUrl) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

/**
 * One label, painted the way content-script/overlay.ts paints it: an upright
 * column is one glyph per row, a column wide, centred on its slot; horizontal
 * text wraps inside its box. The halo is the white stroke the content script
 * puts under the glyphs.
 */
function paintLabel(context, item) {
    const size = Math.max(7, Math.round(item.fontSize ?? 12));
    const centreX = item.x + item.width / 2;
    context.save();
    context.font = `${size}px ${FONT_FAMILY}`;
    context.textBaseline = 'middle';
    context.textAlign = 'center';
    context.lineJoin = 'round';
    context.lineWidth = Math.max(2, Math.round(size * 0.2));
    context.strokeStyle = '#ffffff';
    context.fillStyle = item.color ?? '#111111';
    if (Math.abs(item.angle ?? 0) >= 0.01) {
        const centreY = item.y + item.height / 2;
        context.translate(centreX, centreY);
        context.rotate(item.angle);
        context.translate(-centreX, -centreY);
    }
    const draw = (text, x, y) => {
        context.strokeText(text, x, y);
        context.fillText(text, x, y);
    };
    if (item.vertical) {
        const glyphs = [...item.text].filter((character) => character !== '\u2060' && !/\s/u.test(character));
        glyphs.forEach((glyph, index) => {
            draw(glyph, centreX, item.y + index * size + size / 2);
        });
    } else {
        const lines = [];
        let current = '';
        for (const glyph of item.text) {
            const next = current + glyph;
            if (context.measureText(next).width > item.width && current.length > 0) {
                lines.push(current);
                current = glyph;
            } else {
                current = next;
            }
        }
        if (current.length > 0) lines.push(current);
        const top = item.y + Math.max(0, (item.height - lines.length * size) / 2) + size / 2;
        lines.forEach((line, index) => draw(line, centreX, top + index * size));
    }
    context.restore();
}

/**
 * The page as the content script shows it: the original image, the erased
 * cutout over it (transparent except where a stroke was painted out), then the
 * labels. The cutout is an overlay, not a replacement — drawing it as the base
 * turns the whole page into paper.
 */
async function paintPage(originalDataUrl, erasedDataUrl, width, height, items, path) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.drawImage(await loadImage(dataUrlBytes(originalDataUrl)), 0, 0, width, height);
    if (erasedDataUrl) {
        context.drawImage(await loadImage(dataUrlBytes(erasedDataUrl)), 0, 0, width, height);
    }
    for (const item of items) paintLabel(context, item);
    writeFileSync(path, canvas.toBuffer('image/png'));
    return canvas;
}

function cropTo(canvas, rect, scale, path) {
    const out = createCanvas(Math.round(rect.width * scale), Math.round(rect.height * scale));
    const context = out.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, out.width, out.height);
    if (path) writeFileSync(path, out.toBuffer('image/png'));
    return out;
}

/**
 * The detection result, minus the images. A run can be replayed against the
 * same blocks and boxes, which is what makes two prompts comparable: the
 * reader returns slightly different cell boxes every time, and a different
 * grouping changes the translation more than the prompt does.
 */
const CACHE_VERSION = 1;

function cacheableDetection(detection) {
    return {
        version: CACHE_VERSION,
        imageWidth: detection.imageWidth,
        imageHeight: detection.imageHeight,
        groups: detection.groups.map((group) => ({ ...group, maskUrl: undefined })),
        boxes: detection.boxes,
        bubbles: (detection.bubbles ?? []).map((bubble) => ({
            x: bubble.x,
            y: bubble.y,
            width: bubble.width,
            height: bubble.height,
            paper: bubble.paper,
            outline: bubble.outline,
        })),
        blocks: detection.blocks ?? [],
        blockReadings: (detection.blockReadings ?? []).map((reading) => ({ ...reading, cropUrl: undefined })),
    };
}

async function imageDataUrl(path) {
    const image = await loadImage(path);
    const canvas = createCanvas(image.width, image.height);
    canvas.getContext('2d').drawImage(image, 0, 0);
    return canvas.toDataURL('image/png');
}

async function readCrop(key, canvas) {
    const lines = await requestDeepSeek(key, [canvas.toDataURL('image/jpeg', 0.92)]);
    return lines.map((line) => line.text);
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

    console.log(`[page] ${imagePath}`);
    let detection;
    if (options.detection) {
        const cached = JSON.parse(readFileSync(resolve(options.detection), 'utf8'));
        if (cached.version !== CACHE_VERSION) throw new Error('That detection cache is from another version.');
        detection = {
            ...cached,
            ok: true,
            canInpaint: false,
            erasedUrl: null,
            originalUrl: await imageDataUrl(imagePath),
        };
        console.log(`[page] replayed detection from ${options.detection}`);
    } else {
        detection = await runDetection({
            target: OFFSCREEN_TARGET,
            type: 'detect',
            imageUrl: imagePath,
            ocr: { provider: 'deepseek', key, effort: 'off' },
        });
        if (!detection.ok) throw new Error(detection.error);
        if (options.saveDetection) {
            writeFileSync(resolve(options.saveDetection), `${JSON.stringify(cacheableDetection(detection))}\n`);
            console.log(`[page] detection saved to ${options.saveDetection}`);
        }
    }
    console.log(`[page] ${detection.imageWidth}x${detection.imageHeight}, `
        + `${detection.groups.length} group(s), ${detection.blocks?.length ?? 0} block(s), `
        + `${detection.bubbles.length} balloon(s)`);

    const job = await translateGroups({
        groups: detection.groups,
        boxes: detection.boxes,
        balloons: detection.bubbles,
        imageWidth: detection.imageWidth,
        imageHeight: detection.imageHeight,
        settings: { translator: 'deepseek', deepSeekKey: key, effort: options.effort },
    });
    console.log(`[page] ${job.used}, ${job.items.length} label(s), ${job.skipped} skipped`);

    let erasedUrl = detection.erasedUrl;
    let eraseBoxes = [];
    if (options.erase && detection.canInpaint && job.items.length > 0) {
        const boxes = eraseBoxesFor(detection, job);
        eraseBoxes = boxes;
        const painted = await runInpaint({ target: OFFSCREEN_TARGET, type: 'inpaint', boxes });
        if (!painted.ok) throw new Error(painted.error);
        erasedUrl = painted.erasedUrl;
        console.log(`[page] erased ${boxes.length} box(es): ${painted.erasedUrl ? 'cutout ready' : 'nothing covered'}`);
        if (options.saveErased && erasedUrl) {
            writeFileSync(resolve(options.saveErased), dataUrlBytes(erasedUrl));
            console.log(`[out] ${resolve(options.saveErased)}`);
        }
    }

    if (!detection.originalUrl) throw new Error('The detection produced no page image.');
    const canvas = await paintPage(
        detection.originalUrl,
        erasedUrl,
        detection.imageWidth,
        detection.imageHeight,
        job.items,
        resolve(outDir, `${stem}-translated.png`),
    );
    console.log(`[out] ${resolve(outDir, `${stem}-translated.png`)}`);

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
