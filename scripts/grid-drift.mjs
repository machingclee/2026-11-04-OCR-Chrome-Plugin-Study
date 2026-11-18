/**
 * Where the label lands, against where the ink is.
 *
 * Reading a block asks the model two things at once: what the text says, and
 * where it sits. The first it does well; the second it did badly enough that a
 * label landed beside its column — 20 page pixels out at best, a whole column
 * out at worst. This script measures the part that matters: the frame each
 * label is drawn on, against the ink boxes the detector drew on the reader's
 * crop.
 *
 *   npm run grid:drift -- --all                                   every page in fixtures/drift.json
 *   npm run grid:drift -- --image fixtures/page-wizard.jpg        one page, live reading
 *   npm run grid:drift -- --detection out/eval/det-wizard.json    replay a frozen reading, no network
 *
 * A live run makes one reading call per block, so it measures the answer this
 * prompt produces. A replay measures a frozen answer and costs nothing — that
 * is how a failure is reproduced after the model has moved on. `--save` writes
 * the detection a replay needs; `--crops <dir>` writes the image each block was
 * read from, so the grid behind a drift can be looked at instead of guessed
 * about.
 *
 * Exit code 1 when any label is further than the tolerance from its ink.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { prepareOrt, readApiKey } from './harness/env.mjs';
import { runDetection } from '../src/offscreen/main.ts';

/** Page pixels a frame may sit from its ink before it counts as drifted. */
const DEFAULT_TOLERANCE = 8;
/** How far a frame's width or height may be from its ink's, as a share. */
const DEFAULT_SIZE = 0.25;
const MANIFEST = 'fixtures/drift.json';

function parseArgs(argv) {
    const options = {
        image: null,
        detection: null,
        all: false,
        save: null,
        json: null,
        tolerance: null,
        size: null,
        crops: null,
        verbose: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--image') options.image = argv[++index];
        else if (value === '--detection') options.detection = argv[++index];
        else if (value === '--all') options.all = true;
        else if (value === '--save') options.save = argv[++index];
        else if (value === '--json') options.json = argv[++index];
        else if (value === '--tolerance') options.tolerance = Number(argv[++index]);
        else if (value === '--size') options.size = Number(argv[++index]);
        else if (value === '--crops') options.crops = argv[++index];
        else if (value === '--verbose') options.verbose = true;
        else if (value.startsWith('--')) throw new Error(`Unknown option ${value}`);
        else options.image = options.image ?? value;
    }
    if (!options.all && !options.image && !options.detection) {
        throw new Error('Usage: grid-drift.mjs (--all | --image <page> [--save <json>] | --detection <json>) '
            + '[--tolerance px] [--size share]');
    }
    return options;
}

const rect = (box) => ({ x: box.x, y: box.y, width: box.width, height: box.height });
const centre = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const overlap = (left, right) => (
    Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
    * Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
);

function union(boxes) {
    const x = Math.min(...boxes.map((box) => box.x));
    const y = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.x + box.width));
    const bottom = Math.max(...boxes.map((box) => box.y + box.height));
    return { x, y, width: right - x, height: bottom - y };
}

function measure(box, ink) {
    const own = centre(box);
    const target = centre(ink);
    return {
        dx: Math.round((own.x - target.x) * 10) / 10,
        dy: Math.round((own.y - target.y) * 10) / 10,
        wRatio: ink.width > 0 ? Math.round((box.width / ink.width) * 100) / 100 : 0,
        hRatio: ink.height > 0 ? Math.round((box.height / ink.height) * 100) / 100 : 0,
    };
}

function verdict(metrics, tolerance, size) {
    const reasons = [];
    if (Math.abs(metrics.dx) > tolerance) reasons.push(`dx ${metrics.dx}`);
    if (Math.abs(metrics.dy) > tolerance) reasons.push(`dy ${metrics.dy}`);
    if (Math.abs(metrics.wRatio - 1) > size) reasons.push(`width x${metrics.wRatio}`);
    if (Math.abs(metrics.hRatio - 1) > size) reasons.push(`height x${metrics.hRatio}`);
    return reasons;
}

const show = (box) => `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`;

/** Every box the detector drew on any crop: the ink a frame has to sit on. */
function inkBoxesOf(detection) {
    const boxes = [];
    for (const box of (detection.blockReadings ?? []).flatMap((reading) => reading.boxes ?? [])) {
        if (boxes.some((other) => Math.abs(other.x - box.x) < 2
            && Math.abs(other.y - box.y) < 2
            && Math.abs(other.width - box.width) < 2
            && Math.abs(other.height - box.height) < 2)) continue;
        boxes.push(rect(box));
    }
    return boxes;
}

/**
 * The criterion: the frame each label is drawn on must sit on the ink.
 *
 * The frame is built from the detector's boxes, so the interesting question is
 * not whether one box matches but whether the frame of this line lands on the
 * ink of this line: a frame that covers the column beside it, or that covers
 * two columns at once, fails. A line no block claimed is read from its own
 * detector box, which no crop drew, so its own ink is its truth.
 */
function measurePage(detection, options, label) {
    const inkBoxes = inkBoxesOf(detection);
    const rows = [];
    for (const group of detection.groups ?? []) {
        (group.frames ?? []).forEach((frame, at) => {
            const box = rect(frame);
            const covered = inkBoxes.filter((ink) => box.width > 0 && box.height > 0
                && overlap(box, ink) >= Math.min(box.width * box.height, ink.width * ink.height) * 0.4);
            const own = group.inks?.[at] ? rect(group.inks[at]) : null;
            const row = {
                text: group.lines?.[at] ?? '',
                frame: box,
                ink: covered.length > 0 ? union(covered) : own,
                covered: covered.length,
                reasons: [],
                ...{ dx: 0, dy: 0, wRatio: 0, hRatio: 0 },
            };
            if (row.ink) {
                Object.assign(row, measure(box, row.ink));
                row.reasons = verdict(row, options.tolerance, options.size);
            } else {
                row.reasons = ['no ink box under the frame'];
            }
            rows.push(row);
        });
    }
    for (const row of rows) {
        const flag = row.reasons.length === 0 ? 'ok  ' : 'FAIL';
        console.log(`[${flag}] ${label.padEnd(14)} ${JSON.stringify(row.text.slice(0, 10)).padEnd(14)} `
            + `frame ${show(row.frame).padEnd(20)} ink ${(row.ink ? show(row.ink) : '-').padEnd(20)} `
            + `dx ${row.dx} dy ${row.dy} w x${row.wRatio} h x${row.hRatio}`
            + `${row.covered > 1 ? ` (${row.covered} boxes)` : ''}`
            + `${row.reasons.length > 0 ? `  <- ${row.reasons.join(', ')}` : ''}`);
    }
    const failed = rows.filter((row) => row.reasons.length > 0);
    const worst = (key) => rows.reduce((value, row) => Math.max(value, Math.abs(row[key])), 0);
    const summary = {
        page: label,
        frames: rows.length,
        failed: failed.length,
        worstDx: Math.round(worst('dx') * 10) / 10,
        worstDy: Math.round(worst('dy') * 10) / 10,
        rows,
    };
    console.log(`[drift] ${label}: ${rows.length - failed.length}/${rows.length} label(s) on their ink, `
        + `worst dx ${summary.worstDx}, dy ${summary.worstDy}, tolerance ${options.tolerance}px and ${Math.round(options.size * 100)}%`);
    return summary;
}

async function live(imagePath, options) {
    console.log(`[drift] reading ${imagePath}`);
    const detection = await runDetection({
        target: 'offscreen',
        type: 'detect',
        imageUrl: resolve(imagePath),
        ocr: { provider: 'deepseek', key: readApiKey(), effort: 'off' },
    });
    if (!detection.ok) throw new Error(detection.error);
    if (options.crops) {
        mkdirSync(resolve(options.crops), { recursive: true });
        detection.blockReadings.forEach((reading, index) => {
            if (!reading.cropUrl) return;
            const bytes = Buffer.from(reading.cropUrl.slice(reading.cropUrl.indexOf(',') + 1), 'base64');
            writeFileSync(resolve(options.crops, `block-${index + 1}.jpg`), bytes);
        });
    }
    if (options.save) {
        mkdirSync(dirname(resolve(options.save)), { recursive: true });
        const saved = {
            imageWidth: detection.imageWidth,
            imageHeight: detection.imageHeight,
            blocks: detection.blocks,
            blockReadings: detection.blockReadings.map((reading) => ({ ...reading, cropUrl: undefined })),
            groups: detection.groups.map((group) => ({ ...group, maskUrl: undefined })),
        };
        writeFileSync(resolve(options.save), `${JSON.stringify(saved)}\n`);
        console.log(`[drift] saved ${resolve(options.save)}`);
    }
    return detection;
}

const options = parseArgs(process.argv.slice(2));
const manifest = (() => {
    if (!options.all) return null;
    const file = JSON.parse(readFileSync(resolve(MANIFEST), 'utf8'));
    return {
        tolerance: options.tolerance ?? file.tolerance ?? DEFAULT_TOLERANCE,
        size: options.size ?? file.size ?? DEFAULT_SIZE,
        pages: file.pages,
    };
})();
options.tolerance = options.tolerance ?? manifest?.tolerance ?? DEFAULT_TOLERANCE;
options.size = options.size ?? manifest?.size ?? DEFAULT_SIZE;

const running = (options.all || options.image) ? true : false;
if (running) {
    await prepareOrt();
    if (!readApiKey()) throw new Error('No DeepSeek key in .env');
}

const summaries = [];
if (options.all) {
    for (const entry of manifest.pages) {
        const page = typeof entry === 'string' ? entry : entry.image;
        const detection = await live(page, options);
        summaries.push(measurePage(detection, options, page));
    }
} else if (options.image) {
    summaries.push(measurePage(await live(options.image, options), options, options.image));
} else {
    const path = resolve(options.detection);
    console.log(`[drift] replay ${path}`);
    summaries.push(measurePage(JSON.parse(readFileSync(path, 'utf8')), options, options.detection));
}

const summary = {
    tolerance: options.tolerance,
    size: options.size,
    pages: summaries,
    frames: summaries.reduce((sum, page) => sum + page.frames, 0),
    failed: summaries.reduce((sum, page) => sum + page.failed, 0),
};
if (options.json) {
    mkdirSync(dirname(resolve(options.json)), { recursive: true });
    writeFileSync(resolve(options.json), `${JSON.stringify(summary, null, 2)}\n`);
}
if (summaries.length > 1) {
    console.log(`\n[drift] ${summary.frames - summary.failed}/${summary.frames} label(s) on their ink across `
        + `${summaries.length} page(s)`);
}
process.exit(summary.failed > 0 ? 1 : 0);
