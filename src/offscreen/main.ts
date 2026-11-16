import { renderScoreOverlay } from '../lib/scoreOverlay';
import { detectBubbles, sampleBubblePaper } from '../lib/bubble';
import { cropPreviews } from '../lib/regions';
import { detectLines, isSessionReady } from '../lib/detect';
import { isReadingOfAny, readBlockRegions, readUnclaimedLine, recognizeLinesInCloud } from '../lib/ocr/cloudOcr';
import { isLoneGlyph, spokenGlyphs } from '../lib/loneGlyph';
import { erasePage, type ErasePlanes } from '../lib/erase';
import { inkBounds, paintSamples, paperColour } from '../lib/mask';
import { groupByRegion, splitGroupByColumnGap, toOrderedTextLines } from '../lib/readingOrder';
import { recognizeLine } from '../lib/ocr/recognize';
import { DETECTOR_INPUT_SIZE, OCR_MIN_CONFIDENCE, OFFSCREEN_TARGET } from '../shared/constants';
import type {
    BoxData,
    DetectResponse,
    DetectTimings,
    GroupData,
    IncomingMessage,
    OffscreenDetectRequest,
    OffscreenInpaintRequest,
    OffscreenInpaintResponse,
} from '../shared/types';
import type { Bubble, TextLine, TextMask } from '../lib/types';
import serviceWorkerResponseFactory from '../shared/factories/serviceWorkerResponseFactory';

/** Each crop is a data url in storage, so the strip stops at this many. */
const MAX_PREVIEWS = 60;

/** A line no block claimed is read on its own; the count is capped for cost. */
const MAX_UNCLAIMED_LINES = 6;

/** The page from the last detection, so translation can erase only the lines it keeps. */
let heldPage: { image: ImageData; planes: ErasePlanes } | null = null;

/** Decode inline pixels locally: no round trip, and no data: fetch to trust. */
function decodeImageDataUrl(dataUrl: string): Blob | null {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    const header = dataUrl.slice(5, comma);
    const payload = dataUrl.slice(comma + 1);
    try {
        const bytes = header.endsWith(';base64')
            ? Uint8Array.from(atob(payload), (character) => character.charCodeAt(0))
            : new TextEncoder().encode(decodeURIComponent(payload));
        return new Blob([bytes], { type: header.split(';')[0] || 'image/png' });
    } catch {
        return null;
    }
}

async function fetchImageBlob(url: string): Promise<Blob> {
    // A data: URL already holds the bytes; decoding it here avoids a fetch.
    const inline = url.startsWith('data:') ? decodeImageDataUrl(url) : null;
    if (inline) return inline;
    if (url.startsWith('data:')) throw new Error('The inline image could not be decoded.');

    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`Image fetch failed with ${response.status}.`);
    return response.blob();
}

/** Phone/UI strings that must not be sent to the translator as dialogue. */
const UI_LINE = /^(?:(?:上午|下午|午前|午後)\s*)?\d{1,2}:\d{2}$|^(?:未接來電|購買次數|搜尋|訊號|電量|Wi-?Fi|LTE|5G|4G)$/i;

function isUiLine(text: string): boolean {
    return text.trim().length > 0 && UI_LINE.test(text.trim());
}

/** Repeated kana outside a balloon is almost always a sound effect. */
const KANA_ONLY = /^[\u3040-\u30FF\u30FC]+$/u;

function isSfxLine(text: string): boolean {
    const compact = text.replace(/\s+/g, '');
    if (compact.length === 0 || compact.length > 6 || !KANA_ONLY.test(compact)) return false;
    const characters = [...compact].filter((character) => character !== 'ッ' && character !== 'ン' && character !== 'ー');
    if (characters.length === 0) return false;
    const unique = new Set(characters);
    return unique.size === 1 || characters[0] === characters[characters.length - 1];
}

function skipAsNonDialogue(
    line: BoxData,
    balloons: { x: number; y: number; width: number; height: number }[],
    medianThickness: number,
): boolean {
    const text = line.text.trim();
    if (text.length === 0) return false;
    if (isUiLine(text)) return true;

    const centreX = line.x + line.width / 2;
    const centreY = line.y + line.height / 2;
    const bubble = balloons.find((candidate) =>
        centreX >= candidate.x && centreX <= candidate.x + candidate.width
        && centreY >= candidate.y && centreY <= candidate.y + candidate.height);
    const outside = !bubble;
    if (isSfxLine(text) && outside) return true;

    const normalised = text.replace(/[\s!！?？.…。、・「」『』]/gu, '');
    const kanaOnly = /^[\u3040-\u30FF\u30FC]+$/u.test(normalised);
    const shortSide = Math.min(line.width, line.height);
    const huge = medianThickness > 0 && shortSide > medianThickness * 2.2;

    // A huge repeated kana run is a sound effect, not dialogue. This stays true
    // when the bubble model mistakes the SFX for a balloon. A name such as
    // アリスッ is kana too, but it does not repeat, so it stays.
    if (kanaOnly && normalised.length <= 6 && huge && isSfxLine(text)) return true;

    // Large lettering is often OCR'd as unrelated kanji. When the OCR score is
    // low, that reading is unreliable even if the script is not kana.
    if (huge && line.confidence < 0.7) return true;

    // Short kana-only text outside every balloon is usually OCR noise from a
    // sound effect or artwork. Kanji or mixed script outside a balloon can be
    // narration or a caption, so keep it even when the OCR confidence is low.
    if (outside && kanaOnly && normalised.length <= 8 && line.confidence < 0.7) return true;
    return false;
}

/** Whether a line centre sits inside a group box. */
function centreInsideBox(box: { x: number; y: number; width: number; height: number }, group: { x: number; y: number; width: number; height: number }): boolean {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    return x >= group.x && x <= group.x + group.width && y >= group.y && y <= group.y + group.height;
}
type Rect = { x: number; y: number; width: number; height: number };

/** The area the OCR lines of one group actually occupy. */
function unionOfLines(group: GroupData, lines: BoxData[]): Rect {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const line of lines) {
        if (!centreInsideBox(line, group)) continue;
        minX = Math.min(minX, line.x);
        minY = Math.min(minY, line.y);
        maxX = Math.max(maxX, line.x + line.width);
        maxY = Math.max(maxY, line.y + line.height);
    }
    if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return group;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Read the seg value that belongs to one page pixel. */
function inkAt(mask: TextMask, pageX: number, pageY: number): number {
    const x = Math.round(pageX * mask.scale + mask.padX);
    const y = Math.round(pageY * mask.scale + mask.padY);
    if (x < 0 || y < 0 || x >= DETECTOR_INPUT_SIZE || y >= DETECTOR_INPUT_SIZE) return 0;
    return mask.data[y * DETECTOR_INPUT_SIZE + x];
}

/** Source direction is more reliable than the shape of a merged group box. */
function groupVertical(lines: BoxData[], group: { x: number; y: number; width: number; height: number }): boolean {
    const inside = lines.filter((line) => centreInsideBox(line, group));
    if (inside.length === 0) return false;
    return inside.filter((line) => line.direction === 'vertical').length >= inside.length / 2;
}

/** Original glyph thickness, not the size of the whole group box. */
function groupFontSize(lines: BoxData[], group: { x: number; y: number; width: number; height: number }): number {
    const inside = lines.filter((line) => centreInsideBox(line, group));
    if (inside.length === 0) return 0;
    const vertical = inside.filter((line) => line.direction === 'vertical').length >= inside.length / 2;
    const sizes: number[] = [];
    for (const line of inside) {
        // A vertical column's width and a horizontal row's height are the
        // glyph em box. lineThickness is a fallback for angled lines.
        const side = vertical ? line.width : line.height;
        const thickness = side >= 4
            ? side
            : line.lineThickness && line.lineThickness >= 4 ? line.lineThickness : 0;
        if (thickness > 0) sizes.push(thickness);
    }
    if (sizes.length === 0) return 0;
    sizes.sort((left, right) => left - right);
    return Math.max(6, Math.round(sizes[sizes.length >> 1] * 0.9));
}

/**
 * Give each label the colour of the paper behind its text. A flat patch of the
 * right tone disappears into a balloon or a screentone much better than a pure
 * white sticker. The glyph fill stays dark; the overlay draws the white stroke.
 * This is sampling only; it does not change the image.
 */
/**
 * `plain` drops the paper rectangle for a group the reader built. The
 * glyph-shaped paper is kept: it covers ink the erase left behind, and because
 * it follows the original glyphs it does not read as a white block.
 */
function paintGroupColours(
    bitmap: ImageBitmap,
    groups: GroupData[],
    lines: BoxData[],
    textMask: TextMask | null,
    plain: boolean,
): void {
    if (groups.length === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;

    for (const group of groups) {
        // A reader group is text only. The erase has already removed the ink,
        // so there is nothing for a paper shape, a rectangle or a patch to do:
        // the label is the translated glyphs and their white halo.
        if (plain) {
            group.rectangle = false;
            group.background = 'transparent';
            group.color = '#111111';
            group.maskUrl = undefined;
            group.maskBox = undefined;
            continue;
        }
        group.rectangle = !textMask;
        const rect = unionOfLines(group, lines);
        const [red, green, blue] = paperColour(pixels, bitmap.width, bitmap.height, rect, textMask);
        group.background = `rgb(${red}, ${green}, ${blue})`;
        group.color = '#111111';

        if (!textMask && !plain) continue;
        // The seg mask is the source of truth for glyphs, not the line box.
        // A box that spills outside a balloon therefore cannot paint the paper
        // outside it: only pixels the detector calls ink are in this image.
        //
        // A reader group is different. Its box is already tight around the
        // text, so the page's own pixels are the best mask: they are full
        // resolution and antialiased, where the seg plane is a 1024 map and a
        // 30 px glyph becomes a handful of blocks. Reading the page is what
        // makes the halo follow the characters instead of boxing them.
        const pad = 1;
        const mx0 = Math.max(0, Math.floor(rect.x - pad));
        const my0 = Math.max(0, Math.floor(rect.y - pad));
        const mx1 = Math.min(bitmap.width, Math.ceil(rect.x + rect.width + pad));
        const my1 = Math.min(bitmap.height, Math.ceil(rect.y + rect.height + pad));
        const cropWidth = mx1 - mx0;
        const cropHeight = my1 - my0;
        if (cropWidth <= 0 || cropHeight <= 0) continue;

        const marked = new Uint8Array(cropWidth * cropHeight);
        let inkPixels = 0;
        for (let y = 0; y < cropHeight; y += 1) {
            for (let x = 0; x < cropWidth; x += 1) {
                if (inkAt(textMask as TextMask, mx0 + x + 0.5, my0 + y + 0.5) < 0.3) continue;
                marked[y * cropWidth + x] = 1;
                inkPixels += 1;
            }
        }
        if (inkPixels === 0) continue;

        // Grow by two page pixels to cover the anti-aliased edge of a stroke.
        const grown = new Uint8Array(marked.length);
        for (let y = 0; y < cropHeight; y += 1) {
            for (let x = 0; x < cropWidth; x += 1) {
                if (marked[y * cropWidth + x] === 0) continue;
                const top = Math.max(0, y - 2);
                const bottom = Math.min(cropHeight - 1, y + 2);
                const left = Math.max(0, x - 2);
                const right = Math.min(cropWidth - 1, x + 2);
                for (let ny = top; ny <= bottom; ny += 1) {
                    grown.fill(1, ny * cropWidth + left, ny * cropWidth + right + 1);
                }
            }
        }

        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = cropWidth;
        maskCanvas.height = cropHeight;
        const maskContext = maskCanvas.getContext('2d');
        if (!maskContext) continue;
        const maskImage = maskContext.createImageData(cropWidth, cropHeight);
        for (let index = 0; index < grown.length; index += 1) {
            if (grown[index] === 0) continue;
            const offset = index * 4;
            maskImage.data[offset] = red;
            maskImage.data[offset + 1] = green;
            maskImage.data[offset + 2] = blue;
            maskImage.data[offset + 3] = 255;
        }
        maskContext.putImageData(maskImage, 0, 0);
        group.maskUrl = maskCanvas.toDataURL('image/png');
        group.maskBox = { x: mx0, y: my0, width: cropWidth, height: cropHeight };
    }
}

/**
 * Keep one box per piece of paint. A box with no paint is not a line, and two
 * boxes over the same glyphs are one line seen twice: the second one reads the
 * same column again, the balloon then holds that line twice, and the translator
 * answers with two identical columns. The box that samples more paint wins,
 * because it is the one the glyphs sit in.
 */
function distinctLines<T extends { x: number; y: number; width: number; height: number }>(
    lines: T[],
    det: TextMask | null,
    mask: TextMask | null,
): T[] {
    const painted = lines.map((line) => paintSamples(line, det, mask));
    const dropped = new Set<number>();
    const overlap = (a: T, b: T): number => {
        const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        if (width <= 0 || height <= 0) return 0;
        return (width * height) / Math.min(a.width * a.height, b.width * b.height);
    };
    for (let index = 0; index < lines.length; index += 1) {
        if (painted[index] < 4) {
            dropped.add(index);
            continue;
        }
        for (let other = index + 1; other < lines.length; other += 1) {
            if (dropped.has(other) || overlap(lines[index], lines[other]) < 0.3) continue;
            dropped.add(painted[other] > painted[index] ? index : other);
        }
    }
    return lines.filter((_, index) => !dropped.has(index));
}

/**
 * Sample the paper inside every balloon, so the erase pass can fill it flat
 * instead of asking the model to invent a bubble.
 */
function paintBubblePaper(bitmap: ImageBitmap, bubbles: Bubble[], textMask: TextMask | null): void {
    if (bubbles.length === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    sampleBubblePaper(pixels, bitmap.width, bitmap.height, bubbles, textMask);
}


/** Median luminance of one box, which is its paper for text-heavy areas. */
function boxLuma(pixels: Uint8ClampedArray, pageWidth: number, box: { x: number; y: number; width: number; height: number }): number {
    const x0 = Math.max(0, Math.floor(box.x));
    const y0 = Math.max(0, Math.floor(box.y));
    const x1 = Math.min(pageWidth, Math.ceil(box.x + box.width));
    const values: number[] = [];
    for (let y = y0; y < box.height + y0; y += 3) {
        const offset = y * pageWidth * 4;
        for (let x = x0; x < x1; x += 3) {
            const index = offset + x * 4;
            values.push(0.299 * pixels[index] + 0.587 * pixels[index + 1] + 0.114 * pixels[index + 2]);
        }
    }
    if (values.length === 0) return 255;
    values.sort((left, right) => left - right);
    return values[values.length >> 1];
}

/**
 * The ink of one line, cut from the page itself.
 *
 * The seg plane is a 1024 map and a reading beside a column is part of the same
 * blob there. The page is full resolution, so a band of dark pixels that holds
 * the box centre is the line, and a furigana reading printed above or beside it
 * falls in its own band and is left out. That is what keeps a label from being
 * placed where the reading starts.
 */
function pageInkBounds(
    pixels: Uint8ClampedArray,
    pageWidth: number,
    pageHeight: number,
    box: { x: number; y: number; width: number; height: number },
    paperLuma: number,
): { x: number; y: number; width: number; height: number } | null {
    const vertical = box.height >= box.width;
    const pad = Math.max(4, Math.min(12, Math.round(Math.min(box.width, box.height) * 0.5)));
    const x0 = Math.max(0, Math.floor(box.x - pad));
    const y0 = Math.max(0, Math.floor(box.y - pad));
    const x1 = Math.min(pageWidth - 1, Math.ceil(box.x + box.width + pad));
    const y1 = Math.min(pageHeight - 1, Math.ceil(box.y + box.height + pad));
    const width = x1 - x0 + 1;
    const height = y1 - y0 + 1;
    if (width <= 0 || height <= 0) return null;
    const ink = (x: number, y: number): boolean => {
        const offset = (y * pageWidth + x) * 4;
        return 0.299 * pixels[offset] + 0.587 * pixels[offset + 1] + 0.114 * pixels[offset + 2] < paperLuma - 60;
    };

    const occupied = new Uint8Array(vertical ? width : height);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (!ink(x0 + x, y0 + y)) continue;
            if (vertical) occupied[x] = 1;
            else occupied[y] = 1;
        }
    }
    const centre = vertical ? (box.x + box.width / 2) - x0 : (box.y + box.height / 2) - y0;
    let seed = Math.max(0, Math.min(occupied.length - 1, Math.round(centre)));
    if (!occupied[seed]) {
        let found = -1;
        for (let step = 1; step < occupied.length && found < 0; step += 1) {
            if (seed - step >= 0 && occupied[seed - step]) found = seed - step;
            else if (seed + step < occupied.length && occupied[seed + step]) found = seed + step;
        }
        if (found < 0) return null;
        seed = found;
    }
    let low = seed;
    let high = seed;
    let gap = 0;
    for (let index = seed + 1; index < occupied.length; index += 1) {
        if (occupied[index]) {
            high = index;
            gap = 0;
        } else if (++gap > 2) break;
    }
    gap = 0;
    for (let index = seed - 1; index >= 0; index -= 1) {
        if (occupied[index]) {
            low = index;
            gap = 0;
        } else if (++gap > 2) break;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const across = vertical ? x : y;
            if (across < low || across > high) continue;
            if (!ink(x0 + x, y0 + y)) continue;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX < 0) return null;
    return { x: x0 + minX, y: y0 + minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function recognizeLines(
    bitmap: ImageBitmap,
    lines: TextLine[],
): Promise<BoxData[]> {
    const collected: BoxData[] = [];
    for (const line of lines) {
        const recognised = await recognizeLine(
            bitmap,
            line,
            line.direction === 'vertical',
        ).catch(() => ({ text: '', confidence: 0 }));
        collected.push({ ...line, text: recognised.text, confidence: recognised.confidence });
    }
    return collected;
}

/**
 * Exported for the headless page harness (scripts/render-page.mjs), which runs
 * this same detection and inpaint code in Node so a rendered page can be
 * checked without the browser.
 */
export async function runDetection(request: OffscreenDetectRequest): Promise<DetectResponse> {
    const started = performance.now();
    const warm = isSessionReady();
    const timings: DetectTimings = { fetch: 0, detect: 0, bubble: 0, group: 0, ocr: 0, extras: 0 };

    try {
        const fetchStarted = performance.now();
        // A blob: page cannot be fetched from here, so the picker sends pixels.
        const inline = typeof request.imageDataUrl === 'string' && request.imageDataUrl.length > 0
            ? request.imageDataUrl
            : '';
        const blob = inline
            ? decodeImageDataUrl(inline)
            : await fetchImageBlob(request.imageUrl);
        if (!blob) return { ok: false, error: 'The captured image could not be decoded.' };

        const bitmap = await createImageBitmap(blob);
        timings.fetch = Math.round(performance.now() - fetchStarted);

        // Balloons first, so a column that grows to finish a sentence stops at the
        // balloon edge instead of running into the balloon below.
        let bubbleError: string | null = null;
        const bubbleStarted = performance.now();
        const bubbles = await detectBubbles(bitmap).catch((cause: unknown) => {
            bubbleError = cause instanceof Error ? cause.message : String(cause);
            return null;
        });
        timings.bubble = Math.round(performance.now() - bubbleStarted);
        const balloonList = bubbles ? bubbles.bubbles : [];

        // One whole-page pass. The boxes come from the det head, widened to the
        // glyph strokes of their own column, so a line the det head cut short is
        // still read whole and no box reaches into the column beside it.
        const balloonRects = balloonList.map((bubble) => ({
            x: bubble.x,
            y: bubble.y,
            width: bubble.width,
            height: bubble.height,
        }));
        const reader = request.ocr && request.ocr.key.trim().length > 0 ? request.ocr : null;
        const detectStarted = performance.now();
        // The blocks are the line source when a reader answers. The det boxes
        // are still extracted because they are the fallback when every block
        // comes back empty, and because a page that answers nothing must not
        // leave the user with no boxes at all.
        const detected = await detectLines(bitmap, balloonRects);
        timings.detect = Math.round(performance.now() - detectStarted);

        const groupStarted = performance.now();

        // The block head gives region boxes, and each block is one crop for the
        // reader. The model then reports the text and where it sits inside the
        // block, so the block is both the detection unit and the group.
        let readings = null as Awaited<ReturnType<typeof readBlockRegions>> | null;
        if (reader && detected.blkBoxes.length > 0) {
            readings = await readBlockRegions(bitmap, detected.blkBoxes, reader, detected.detBoxes)
                .catch((cause: unknown) => {
                    console.warn('Block reading failed, falling back to the line path.', cause);
                    return null;
                });
        }
        const blockReadings = (readings ?? []).filter((reading) => reading.regions.length > 0);
        const pagePixels = (() => {
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) return null;
            context.drawImage(bitmap, 0, 0);
            return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        })();

        let grouped: ReturnType<typeof groupByRegion>;
        let collected: BoxData[];
        let cloud: Awaited<ReturnType<typeof recognizeLinesInCloud>> | null = null;

        if (blockReadings.length > 0) {
            const lines: BoxData[] = [];
            const boxes: { x: number; y: number; width: number; height: number; score: number }[] = [];
            const balloonFlags: boolean[] = [];
            // The order of the groups is the order the translator reads the page
            // in, so the context holds: top to bottom, right to left inside a
            // panel. The blk boxes arrive in score order, which would make the
            // first region the most confident one rather than the first one.
            const pageOrder = [...blockReadings].sort((left, right) => (
                left.block.y - right.block.y || right.block.x - left.block.x
            ));
            pageOrder.forEach((reading) => {
                const ordered = [...reading.regions].sort((left, right) => (
                    left.direction === 'v' || right.direction === 'v'
                        ? right.x - left.x
                        // A horizontal block is read row by row and, inside a
                        // row, left to right. Without the second key the small
                        // prefix and the large name can swap places.
                        : (left.y - right.y) || (left.x - right.x)
                ));
                ordered.forEach((region) => {
                    const line: BoxData = {
                        ...region,
                        direction: region.direction === 'v' ? 'vertical' : 'horizontal',
                        score: reading.block.score,
                        ruby: [],
                        // The block score measures the blk box, not the reading.
                        // Gating the text on it drops a real block that scored
                        // low, and the erase set is independent of this value, so
                        // the line would be erased with nothing pasted over it.
                        confidence: 1,
                        kind: region.kind,
                        translation: region.translation,
                    };
                    // The model's box is an estimate. The strokes are where the
                    // glyphs are, so the line is snapped to the ink it covers.
                    // The width of that ink is also the size the font follows.
                    const paperLuma = pagePixels ? boxLuma(pagePixels, bitmap.width, line) : 255;
                    const ink = Math.abs(line.angle ?? 0) < 0.01
                        ? (pagePixels && paperLuma > 128
                            ? pageInkBounds(pagePixels, bitmap.width, bitmap.height, line, paperLuma) ?? inkBounds(detected.mask, line)
                            : inkBounds(detected.mask, line))
                        : null;
                    // A snap that lands mostly outside the reader's box is not this
                    // line's ink: the column search walked into the neighbour and
                    // returned a sliver of it, which left 連れて as an 8x4 box and
                    // split its balloon. Such a snap is dropped, and the reader's
                    // box stands.
                    const sharedInk = ink
                        ? Math.max(0, Math.min(ink.x + ink.width, line.x + line.width) - Math.max(ink.x, line.x))
                            * Math.max(0, Math.min(ink.y + ink.height, line.y + line.height) - Math.max(ink.y, line.y))
                        : 0;
                    if (ink && sharedInk >= ink.width * ink.height * 0.6) {
                        line.x = ink.x;
                        line.y = ink.y;
                        line.width = ink.width;
                        line.height = ink.height;
                    }
                    // The reader read the box off the grid drawn on its crop,
                    // so the box is data, not an estimate. It is what the label
                    // covers; the line's own box stays tight around the ink,
                    // because that box is what gets erased.
                    const verticalLine = line.direction === 'vertical';
                    const inclined = Math.abs(line.angle ?? 0) >= 0.01;
                    if (!inclined) {
                        let slot = {
                            x: region.x,
                            y: region.y,
                            width: region.width,
                            height: region.height,
                        };
                        // The font is the grid: how many cells the character
                        // covers, times the size of one cell. Two cells of a 9
                        // pixel grid are an 18 pixel character.
                        //
                        // The box across is a lower bound, because it is drawn
                        // around the ink and an em is wider than its ink: a two
                        // cell character can come back as a one cell box, which
                        // halved the font. The run of characters is the better
                        // estimate, because its rounding error is divided by the
                        // number of characters, so the larger of the two is used.
                        const characters = Math.max(1, [...line.text].length);
                        const acrossCells = region.cells
                            ? (verticalLine ? region.cells.width : region.cells.height)
                            : 0;
                        const alongCells = region.cells
                            ? (verticalLine ? region.cells.height : region.cells.width)
                            : 0;
                        const read = verticalLine ? slot.width : slot.height;
                        // The run estimate can only be off by the rounding of the
                        // across one, so it is allowed one cell more than that.
                        const em = acrossCells > 0
                            ? Math.max(acrossCells, Math.min(alongCells / characters, acrossCells + 1))
                            : 0;
                        const size = em > 0 && reading.cell > 0 ? em * reading.cell : read;
                        if (size >= 4) {
                            // The label's column is one character wide, not the
                            // width of the reader's box: that box hugs the ink,
                            // which is narrower than the em, so a label sized to
                            // the em did not fit its own box and the renderer
                            // shrank it back down. Centred on the reader's box.
                            slot = verticalLine
                                ? { ...slot, x: slot.x + slot.width / 2 - size / 2, width: size }
                                : { ...slot, y: slot.y + slot.height / 2 - size / 2, height: size };
                            line.lineLength = verticalLine ? slot.height : slot.width;
                            // The character is the em; the renderer multiplies
                            // its input by 1.2.
                            line.lineThickness = size / 1.2;
                        }
                        line.slot = slot;
                        console.info(`[cell] "${line.text.slice(0, 12)}" box ${Math.round(slot.x)},${Math.round(slot.y)} `
                            + `${Math.round(slot.width)}x${Math.round(slot.height)} `
                            + `em ${size.toFixed(1)}px = ${acrossCells} across, ${alongCells}/${characters} along, `
                            + `cell ${reading.cell}px`);
                    } else if (region.glyphSize && region.glyphSize >= 4) {
                        // An inclined line is not on the cell grid, so its size
                        // stays the advance the model's own text measured.
                        line.lineThickness = region.glyphSize / 1.2;
                    }
                    lines.push(line);
                });
                boxes.push(reading.block);
                const centreX = reading.block.x + reading.block.width / 2;
                const centreY = reading.block.y + reading.block.height / 2;
                balloonFlags.push(balloonList.some((bubble) =>
                    centreX >= bubble.x && centreX <= bubble.x + bubble.width
                    && centreY >= bubble.y && centreY <= bubble.y + bubble.height));
            });

            // The blk head can miss a small balloon that sits in the corner of a
            // bigger block's crop, and the reader then reports only the balloon
            // it was pointed at: the 円 printed beside a speech came back as no
            // region at all, so it was never translated. A detected line that no
            // reported region covers is still text, so it is read on its own;
            // the column gap split below gives it a group of its own.
            //
            // A line is claimed when a region covers it. Being inside a block box
            // is not enough: the reader left it out. The share is 0.3 rather than
            // a half because a reader box is snapped to its grid, and a cell of
            // slack left the 円 it had reported uncovered.
            const claimedBy = (box: Rect): boolean =>
                lines.some((line) => {
                    const sharedWidth = Math.min(line.x + line.width, box.x + box.width) - Math.max(line.x, box.x);
                    const sharedHeight = Math.min(line.y + line.height, box.y + box.height) - Math.max(line.y, box.y);
                    if (sharedWidth <= 0 || sharedHeight <= 0) return false;
                    return (sharedWidth * sharedHeight)
                        / Math.min(line.width * line.height, box.width * box.height) > 0.3;
                });
            /** Which balloon holds this box, or -1 when none does. */
            const balloonAt = (box: Rect): number => {
                const centreX = box.x + box.width / 2;
                const centreY = box.y + box.height / 2;
                return balloonList.findIndex((bubble) => centreX >= bubble.x && centreX <= bubble.x + bubble.width
                    && centreY >= bubble.y && centreY <= bubble.y + bubble.height);
            };
            // Only inside a balloon: a balloon is a speech container, so text in
            // it is speech. A formula or a signature the reader ignored outside
            // one stays ignored. A balloon that already reports a one-character
            // name is settled: its other box is the reading beside that name, and
            // the reader's box can sit a cell off the ink, which made the same
            // glyph look unclaimed and had it read again as 門.
            const namedBalloons = new Set<number>();
            for (const line of lines) {
                if (spokenGlyphs(line.text).length !== 1) continue;
                const bucket = balloonAt(line);
                if (bucket >= 0) namedBalloons.add(bucket);
            }
            const unclaimed = reader
                ? detected.detBoxes.filter((box) => {
                    const bucket = balloonAt(box);
                    return bucket >= 0 && !namedBalloons.has(bucket) && !claimedBy(box);
                }).slice(0, MAX_UNCLAIMED_LINES)
                : [];
            const extra: BoxData[] = [];
            for (const box of unclaimed) {
                const line: TextLine = {
                    ...box,
                    direction: box.height >= box.width ? 'vertical' : 'horizontal',
                    ruby: [],
                };
                const read = await readUnclaimedLine(bitmap, line, reader?.key ?? '').catch(() => null);
                if (!read || read.text.trim().length === 0) continue;
                extra.push(read);
                console.info(`[read] unclaimed line ${Math.round(box.x)},${Math.round(box.y)} `
                    + `${Math.round(box.width)}x${Math.round(box.height)} -> ${JSON.stringify(read.text)}`);
            }
            // A name is one glyph, so one misread glyph is the whole label: the
            // reader turned 円 into 門 on one run in eight. The recogniser trained
            // on printed manga is more reliable on that tight box, and it reads
            // 円 at 0.99, so a one-glyph line is confirmed against it. A low
            // confidence leaves the reader's text alone.
            // A kana word the reader turned into kanji: ねえ came back as お元,
            // as 我元, and once as two separate kanji regions 我 / 死 — which is
            // why the check below runs on the block first, and on a line second.
            const KANA_WORD = /^[\u3040-\u309F\u30A0-\u30FF\u30FC]+$/u;
            // Read the block as one box when its whole text is a short word that
            // the reader gave in the wrong script. The reader can split a two
            // kana bubble into two one-glyph regions, and then no per-line check
            // ever sees a line long enough to doubt; the box it split is one
            // word to the recogniser.
            for (const reading of pageOrder) {
                const inBlock = lines.filter((line) => centreInsideBox(line, reading.block));
                if (inBlock.length === 0) continue;
                const text = inBlock.map((line) => line.text).join('');
                const glyphs = spokenGlyphs(text);
                if (glyphs.length === 0 || glyphs.length > 3 || KANA_WORD.test(glyphs.join(''))) continue;
                const left = Math.min(...inBlock.map((line) => line.x));
                const top = Math.min(...inBlock.map((line) => line.y));
                const right = Math.max(...inBlock.map((line) => line.x + line.width));
                const bottom = Math.max(...inBlock.map((line) => line.y + line.height));
                const crop: TextLine = {
                    x: left,
                    y: top,
                    width: right - left,
                    height: bottom - top,
                    score: reading.block.score,
                    direction: bottom - top >= right - left ? 'vertical' : 'horizontal',
                    ruby: [],
                };
                const local = await recognizeLine(bitmap, crop, crop.direction === 'vertical')
                    .catch(() => null);
                if (!local || local.confidence < 0.9) continue;
                const read = spokenGlyphs(local.text);
                if (read.length !== glyphs.length || !KANA_WORD.test(read.join(''))) continue;
                console.info(`[read] short block ${JSON.stringify(text)} re-read as `
                    + `${JSON.stringify(local.text.trim())}, local ${local.confidence.toFixed(2)}`);
                const keep = inBlock[0];
                keep.text = local.text.trim();
                keep.x = left;
                keep.y = top;
                keep.width = right - left;
                keep.height = bottom - top;
                for (const line of inBlock.slice(1)) {
                    const at = lines.indexOf(line);
                    if (at >= 0) lines.splice(at, 1);
                }
            }
            // A short line is confirmed when the device reads the same number of glyphs
            // in kana, which is a different reading of the same box rather than
            // a different line.
            const shortKanaMisread = (text: string): boolean => {
                const glyphs = spokenGlyphs(text);
                return glyphs.length >= 2 && glyphs.length <= 3 && !KANA_WORD.test(glyphs.join(''));
            };
            for (const line of lines) {
                // A name glyph only: a single kana is dialogue (「え？」), where
                // the reader has the sentence around it and the recogniser does
                // not.
                const lone = isLoneGlyph(line.text);
                const misread = shortKanaMisread(line.text);
                if (!lone && !misread) continue;
                // The detector's line box is where the ink is. The reader's box is
                // a cell or two off, and a crop that cuts the glyph costs the
                // recogniser the confidence the tie-break depends on.
                let crop: TextLine = line;
                let best = 0;
                for (const box of detected.detBoxes) {
                    const sharedWidth = Math.min(line.x + line.width, box.x + box.width) - Math.max(line.x, box.x);
                    const sharedHeight = Math.min(line.y + line.height, box.y + box.height) - Math.max(line.y, box.y);
                    if (sharedWidth <= 0 || sharedHeight <= 0) continue;
                    const share = (sharedWidth * sharedHeight)
                        / Math.min(line.width * line.height, box.width * box.height);
                    if (share <= best) continue;
                    best = share;
                    crop = {
                        x: box.x,
                        y: box.y,
                        width: box.width,
                        height: box.height,
                        score: box.score,
                        direction: line.direction,
                        ruby: [],
                    };
                }
                if (best <= 0.3) crop = line;
                const local = await recognizeLine(bitmap, crop, line.direction === 'vertical')
                    .catch(() => null);
                if (!local || local.confidence < OCR_MIN_CONFIDENCE) continue;
                const glyphs = spokenGlyphs(local.text);
                if (!lone) {
                    const deviceKana = glyphs.length === spokenGlyphs(line.text).length
                        && KANA_WORD.test(glyphs.join(''));
                    if (local.confidence < 0.9 || !deviceKana) continue;
                    console.info(`[read] short line ${JSON.stringify(line.text)} re-read as `
                        + `${JSON.stringify(local.text.trim())}, local ${local.confidence.toFixed(2)}`);
                    line.text = local.text.trim();
                    continue;
                }
                if (glyphs.length !== 1 || glyphs[0] === spokenGlyphs(line.text)[0]) continue;
                console.info(`[read] one-glyph line ${JSON.stringify(line.text)} re-read as `
                    + `${JSON.stringify(local.text.trim())}, local ${local.confidence.toFixed(2)}, `
                    + `box ${Math.round(crop.x)},${Math.round(crop.y)} ${Math.round(crop.width)}x${Math.round(crop.height)}`);
                line.text = local.text.trim();
            }
            // The kana printed beside a name is its reading, not a line: つぶら
            // beside 円. The new lines are judged against every line at once, so
            // the order they were read in cannot decide which one is the host.
            const base = lines.length;
            const inked = [...lines, ...extra].map((line) => ({
                direction: line.direction === 'vertical' ? 'v' as const : 'h' as const,
                x: line.x,
                y: line.y,
                width: line.width,
                height: line.height,
                text: line.text,
            }));
            // The same text read twice is one line: the reader reported この２人
            // on its grid and the detector's own box came back as この2人, and
            // the balloon then carried both. Full-width and half-width forms are
            // the same text, so the comparison runs over the normalised form.
            const normalised = (text: string): string => text.normalize('NFKC').replace(/\s/gu, '');
            const alreadyRead = (line: BoxData): boolean => lines.some((other) => {
                if (normalised(other.text) !== normalised(line.text)) return false;
                const size = Math.max(other.width, other.height, line.width, line.height);
                const distance = Math.hypot(
                    (other.x + other.width / 2) - (line.x + line.width / 2),
                    (other.y + other.height / 2) - (line.y + line.height / 2),
                );
                return distance <= size * 2;
            });
            extra.forEach((line, index) => {
                const self = base + index;
                if (isReadingOfAny(inked[self], inked.filter((_, at) => at !== self))) {
                    console.info(`[read] unclaimed line ${JSON.stringify(line.text)} is a reading, not a line`);
                    return;
                }
                if (alreadyRead(line)) {
                    console.info(`[read] unclaimed line ${JSON.stringify(line.text)} was already read`);
                    return;
                }
                lines.push(line);
            });

            grouped = {
                lines,
                grouped: boxes.length,
                dropped: 0,
                regions: boxes.length,
                boxes,
                balloonFlags,
            };
            collected = lines;
        } else {
            const ordered = toOrderedTextLines(detected.detBoxes, [], true);
            grouped = groupByRegion(ordered, balloonList, [], false);
            // A pass can hand a child the parent's score, so a box can still end
            // up over paper that holds no paint, or two boxes can end up over the
            // same glyphs. The first is not a line; the second is one line read
            // twice, which is how a balloon got the same sentence in two columns.
            const paintedLines = distinctLines(grouped.lines, detected.det, detected.mask);
            if (paintedLines.length !== grouped.lines.length) {
                console.info(`Dropped ${grouped.lines.length - paintedLines.length} line boxes with no paint or no own text.`);
            }
            if (reader) {
                cloud = await recognizeLinesInCloud(bitmap, paintedLines, reader);
            }
            collected = cloud ? cloud.lines : await recognizeLines(bitmap, paintedLines);
        }
        timings.group = Math.round(performance.now() - groupStarted);
        timings.ocr = 0;
        timings.extras = Math.round(performance.now() - started - timings.fetch - timings.detect - timings.group - timings.ocr);

        const thicknesses = collected
            .map((line) => Math.min(line.width, line.height))
            .filter((size) => size >= 4)
            .sort((left, right) => left - right);
        const medianThickness = thicknesses.length > 0 ? thicknesses[thicknesses.length >> 1] : 0;
        const usable = collected.filter((line) =>
            line.confidence >= OCR_MIN_CONFIDENCE
            // The reader already said this one is a sound effect, so it is not
            // translated and not covered.
            && line.kind !== 'sfx'
            // A line the reader returned is trusted: it saw the crop, so the
            // kana and size heuristics that guard the on-device recogniser do
            // not apply to it. An empty text is how it says there is no text.
            && (line.kind ? true : !skipAsNonDialogue(line, balloonList, medianThickness)),
        );

        const groups: GroupData[] = [];
        const perGroup: string[][] = grouped.boxes.map(() => []);
        const perGroupTranslations: string[][] = grouped.boxes.map(() => []);
        for (const line of usable) {
            for (let index = 0; index < grouped.boxes.length; index += 1) {
                if (!centreInsideBox(line, grouped.boxes[index])) continue;
                perGroup[index].push(line.text);
                perGroupTranslations[index].push(line.translation ?? '');
                break;
            }
        }
        grouped.boxes.forEach((box, index) => {
            const text = perGroup[index].filter((value) => value.length > 0);
            if (text.length > 0) groups.push({
                ...box,
                lines: text,
                // The reading call writes the translation with the text, so the
                // page does not need a second request. Lines it left
                // untranslated carry an empty string and the translator fills
                // only those.
                ...(perGroupTranslations[index].some((value) => value.trim().length > 0)
                    ? { translations: perGroupTranslations[index] }
                    : {}),
                fontSize: groupFontSize(usable, box),
                vertical: groupVertical(usable, box),
                balloon: grouped.balloonFlags[index] ?? false,
            });
        });
        for (const line of usable) {
            if (groups.some((group) => centreInsideBox(line, group))) continue;
            if (line.text.length === 0) continue;
            groups.push({
                x: line.x,
                y: line.y,
                width: line.width,
                height: line.height,
                lines: [line.text],
                fontSize: groupFontSize(usable, line),
                vertical: line.direction === 'vertical',
                balloon: false,
            });
        }

        // A merged balloon region can hold two physical balloons. Split by the
        // gap between columns before translation, or the two speeches become one
        // paragraph that can only be placed in one of them.
        const splitGroups: GroupData[] = [];
        for (const group of groups) {
            const clusters = splitGroupByColumnGap(group, usable);
            if (clusters.length <= 1) {
                splitGroups.push(group);
                continue;
            }
            for (const cluster of clusters) {
                const text = cluster.map((line) => line.text).filter((value) => value.length > 0);
                if (text.length === 0) continue;
                let minX = Number.POSITIVE_INFINITY;
                let minY = Number.POSITIVE_INFINITY;
                let maxX = Number.NEGATIVE_INFINITY;
                let maxY = Number.NEGATIVE_INFINITY;
                for (const line of cluster) {
                    minX = Math.min(minX, line.x);
                    minY = Math.min(minY, line.y);
                    maxX = Math.max(maxX, line.x + line.width);
                    maxY = Math.max(maxY, line.y + line.height);
                }
                const clusterBox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
                splitGroups.push({
                    ...clusterBox,
                    lines: text,
                    fontSize: groupFontSize(usable, clusterBox),
                    vertical: groupVertical(usable, clusterBox),
                    balloon: group.balloon ?? false,
                });
            }
        }

        // The block path hires the stroke plane only to paint the balloon paper
        // and the label masks. The erase mask comes from the det plane, which is
        // what the block path is allowed to rely on.
        const strokeMask = detected.mask;
        paintBubblePaper(bitmap, balloonList, strokeMask);
        // A group from the reader is drawn as text with its own white halo. The
        // glyph-shaped paper label is built from the seg plane at detector
        // resolution, so on a reader group it reads as white blocks rather than
        // the outline of the characters.
        paintGroupColours(bitmap, splitGroups, usable, strokeMask, blockReadings.length > 0);

        console.info(`[erase] ${collected.length} line(s) read, `
            + `${collected.filter((line) => line.text.trim().length > 0 && line.kind !== 'sfx').length} candidate box(es), `
            + `page ${bitmap.width}x${bitmap.height}`);
        const previews = cropPreviews(bitmap, collected.slice(0, MAX_PREVIEWS));

        const originalCanvas = document.createElement('canvas');
        originalCanvas.width = bitmap.width;
        originalCanvas.height = bitmap.height;
        const originalContext = originalCanvas.getContext('2d');
        originalContext?.drawImage(bitmap, 0, 0);
        const originalUrl = originalContext ? originalCanvas.toDataURL('image/webp', 0.95) : null;

        heldPage = null;
        // Both planes go to the erase: the det band says where a line of text
        // runs, the seg plane marks its strokes.
        if (detected.mask || detected.det) {
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (context) {
                context.drawImage(bitmap, 0, 0);
                heldPage = {
                    image: context.getImageData(0, 0, canvas.width, canvas.height),
                    planes: { seg: detected.mask, det: detected.det },
                };
            }
        }

        const detUrl = detected.det
            ? renderScoreOverlay(detected.det, bitmap.width, bitmap.height, [255, 120, 20])
            : null;
        const segUrl = detected.mask
            ? renderScoreOverlay(detected.mask, bitmap.width, bitmap.height, [20, 190, 255])
            : null;

        return {
            ok: true,
            boxes: collected,
            previews,
            detUrl,
            segUrl,
            erasedUrl: null,
            canInpaint: heldPage !== null,
            originalUrl,
            ocrProvider: blockReadings.length > 0 ? reader?.provider : cloud?.provider,
            ocrFallbacks: cloud?.fallbacks,
            ocrCloudLines: blockReadings.length > 0 ? collected.length : cloud?.cloudLines,
            // A region with no text is not erased: it may be a noise box over
            // artwork, and blanking it would remove drawing rather than ink.
            // A sound effect keeps its ink: it is not translated, so erasing it
            // would leave a blank panel. The box is the reader's own region,
            // with a small margin for the strokes at its edge.
            //
            // The region matters, not the block. The mask grows around every
            // stroke by a fifth of the text size, and a block's size is not a
            // text size: erasing a whole block grew the mask into a blob that
            // swallowed the balloon.
            eraseBoxes: collected
                .filter((line) => line.text.trim().length > 0 && line.kind !== 'sfx')
                .filter((line) => line.width * line.height <= bitmap.width * bitmap.height * 0.2)
                .map((line) => {
                    // The region is snapped to its ink, so a few pixels cover
                    // the stroke rim; a wider pad reached the balloon wall.
                    const pad = 3;
                    const x = Math.max(0, line.x - pad);
                    const y = Math.max(0, line.y - pad);
                    const right = Math.min(bitmap.width, line.x + line.width + pad);
                    const bottom = Math.min(bitmap.height, line.y + line.height + pad);
                    return {
                        x,
                        y,
                        width: right - x,
                        height: bottom - y,
                        angle: line.angle,
                        kind: 'region' as const,
                    };
                }),
            imageWidth: bitmap.width,
            imageHeight: bitmap.height,
            groupedLines: grouped.lines.length,
            groups: splitGroups,
            bubbleError,
            bubbles: balloonList.map((bubble) => ({
                x: bubble.x,
                y: bubble.y,
                width: bubble.width,
                height: bubble.height,
                outline: bubble.outline,
                paper: bubble.paper,
            })),
            blocks: detected.blkBoxes.map((block) => ({ ...block })),
            blockReadings: (readings ?? []).map((reading) => ({
                block: reading.block,
                raw: reading.raw ?? '',
                cropUrl: reading.cropUrl,
                boxes: reading.boxes,
                regions: reading.regions.map((region) => ({
                    x: region.x,
                    y: region.y,
                    width: region.width,
                    height: region.height,
                    text: region.text,
                    direction: region.direction,
                    kind: region.kind,
                })),
            })),
            ms: Math.round(performance.now() - started),
            warm,
            timings,
        };
    } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
}

/**
 * Erase the strokes inside the boxes that received a translation. Sound effects
 * are omitted from that list, so their ink stays on the page. The detector mask
 * says where the ink is. A box on balloon paper is filled flat; the rest is
 * inpainted, because only the paint around it can say what belongs there.
 */
export async function runInpaint(request: OffscreenInpaintRequest): Promise<OffscreenInpaintResponse> {
    const page = heldPage;
    if (!page || request.boxes.length === 0) return { ok: true, erasedUrl: null };
    try {
        const erased = await erasePage(page.image, page.planes, request.boxes);
        if (erased.covered === 0) return { ok: true, erasedUrl: null };

        const overlay = document.createElement('canvas');
        overlay.width = page.image.width;
        overlay.height = page.image.height;
        const overlayContext = overlay.getContext('2d');
        if (!overlayContext) return { ok: true, erasedUrl: null };
        const cutout = overlayContext.createImageData(page.image.width, page.image.height);
        cutout.data.set(erased.data);
        overlayContext.putImageData(cutout, 0, 0);
        return { ok: true, erasedUrl: overlay.toDataURL('image/png') };
    } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
}

// this is off the offscreen document. The listener is registered only where a
// runtime exists: the page harness imports this module for runDetection alone.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const request = message as IncomingMessage | undefined;
    if (!request || request.target !== OFFSCREEN_TARGET) return false;

    if (request.type === 'ping') {
        sendResponse(serviceWorkerResponseFactory.ofPing());
        return false;
    }

    if (request.type === 'inpaint') {
        void runInpaint(request).then(sendResponse);
        return true;
    }

    void runDetection(request).then(sendResponse);
    return true;
});
}
