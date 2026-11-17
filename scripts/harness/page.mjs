/**
 * One page through the extension's real pipeline, and the renderer that shows
 * the result.
 *
 * `runPage` is the sequence the service worker and the offscreen document run —
 * detect, translate, erase — and then the same pass the content script makes
 * over the finished page. The single-page harness and the regression suite both
 * call this, so there is one copy of the sequence: a suite that kept its own
 * copy of the erase geometry measured a different pipeline than the one shipped.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEFAULT_REASONING_EFFORT } from '../../src/shared/constants.ts';
import { createCanvas, loadImage, prepareOrt, readApiKey } from './env.mjs';
import { runDetection, runInpaint } from '../../src/offscreen/main.ts';
import { translateGroups } from '../../src/lib/translationJob.ts';
import { requestDeepSeek } from '../../src/lib/ocr/cloudOcr.ts';
import { blockCropBox } from '../../src/lib/ocr/blockCrop.ts';

const FONT_FAMILY = '"PingFang TC", "Heiti TC", "Hiragino Sans", "Arial Unicode MS", sans-serif';

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
    // The same area the service worker erases: the crop the reader was given.
    // Anything else here measures a different erase than the app performs.
    const areaOf = (reading) => {
        const crop = blockCropBox(detection.imageWidth, detection.imageHeight, reading.block, reading.boxes ?? []);
        return crop.width > 0 && crop.height > 0 ? crop : null;
    };
    const readable = (detection.blockReadings ?? [])
        .filter((reading) => reading.regions.some((region) => region.kind !== 'sfx' && region.text.trim().length > 0));
    const dialogueBlocks = readable
        .filter((reading) => job.labelled.some((box) => overlaps(box, reading.block)))
        .map((reading) => ({
            ...(areaOf(reading) ?? rectOf(reading.block)),
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

/**
 * Run one image through detection, translation and erase, and paint the
 * overlay onto its pages.
 */
export async function runPage(options) {
    const { imagePath, key, effort = DEFAULT_REASONING_EFFORT, erase = true, ocr = true } = options;
    const detection = options.detection ?? await runDetection({
        target: 'offscreen',
        type: 'detect',
        imageUrl: imagePath,
        ocr: { provider: 'deepseek', key, effort: 'off' },
    });
    if (!detection.ok) throw new Error(detection.error);

    const job = await translateGroups({
        groups: detection.groups,
        boxes: detection.boxes,
        balloons: detection.bubbles,
        imageWidth: detection.imageWidth,
        imageHeight: detection.imageHeight,
        settings: { translator: 'deepseek', deepSeekKey: key, effort },
    });

    let erasedUrl = detection.erasedUrl;
    let eraseBoxes = [];
    if (erase && detection.canInpaint && job.items.length > 0) {
        eraseBoxes = eraseBoxesFor(detection, job);
        const painted = await runInpaint({ target: 'offscreen', type: 'inpaint', boxes: eraseBoxes });
        if (!painted.ok) throw new Error(painted.error);
        erasedUrl = painted.erasedUrl;
    }

    if (!detection.originalUrl) throw new Error('The detection produced no page image.');
    const canvas = createCanvas(detection.imageWidth, detection.imageHeight);
    const context = canvas.getContext('2d');
    context.drawImage(await loadImage(dataUrlBytes(detection.originalUrl)), 0, 0, detection.imageWidth, detection.imageHeight);
    if (erasedUrl) {
        context.drawImage(await loadImage(dataUrlBytes(erasedUrl)), 0, 0, detection.imageWidth, detection.imageHeight);
    }
    for (const item of job.items) paintLabel(context, item);

    return {
        detection,
        job,
        eraseBoxes,
        erasedUrl,
        canvas,
        imageWidth: detection.imageWidth,
        imageHeight: detection.imageHeight,
        ocr,
        save(path) {
            writeFileSync(path, canvas.toBuffer('image/png'));
            return path;
        },
    };
}

export {
    CACHE_VERSION,
    overlaps,
    rectOf,
    cacheableDetection,
    cropTo,
    dataUrlBytes,
    eraseBoxesFor,
    imageDataUrl,
    paintLabel,
    readCrop,
};
