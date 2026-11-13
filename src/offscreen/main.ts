import { detectBoxes, extendCutEnds, isSessionReady, stopAtBubbles, suppressOverlaps } from '../lib/detector';
import { renderScoreOverlay } from '../lib/scoreOverlay';
import { detectBubbles } from '../lib/bubble';
import { cropPreviews } from '../lib/regions';
import { expandToInk } from '../lib/expand';
import { trimMergedRuby } from '../lib/trimRuby';
import { inpaintPage } from '../lib/inpaint';
import { refineMask } from '../lib/mask';
import { canTranslate, translateAll } from '../lib/translate';
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
import type { TextLine, TextMask } from '../lib/types';
import serviceWorkerResponseFactory from '../shared/factories/serviceWorkerResponseFactory';

/** Each crop is a data url in storage, so the strip stops at this many. */
const MAX_PREVIEWS = 30;

/** The page from the last detection, so translation can erase only the lines it keeps. */
let heldPage: { image: ImageData; textMask: TextMask } | null = null;

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

function median(values: number[]): number {
    if (values.length === 0) return 255;
    values.sort((left, right) => left - right);
    return values[values.length >> 1];
}

/**
 * Give each label the colour of the paper just outside its text. A flat patch
 * of the right tone disappears into a balloon or a screentone much better than
 * a pure white sticker. The glyph fill stays dark; the overlay draws the white stroke.
 * This is sampling only; it does not change the image.
 */
function paintGroupColours(
    bitmap: ImageBitmap,
    groups: GroupData[],
    lines: BoxData[],
    textMask: TextMask | null,
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
        group.rectangle = !textMask;
        const rect = unionOfLines(group, lines);
        const growX = Math.max(2, Math.round(rect.width * 0.08));
        const growY = Math.max(2, Math.round(rect.height * 0.08));
        const x0 = Math.max(0, Math.floor(rect.x - growX));
        const y0 = Math.max(0, Math.floor(rect.y - growY));
        const x1 = Math.min(bitmap.width - 1, Math.ceil(rect.x + rect.width + growX));
        const y1 = Math.min(bitmap.height - 1, Math.ceil(rect.y + rect.height + growY));
        if (x1 <= x0 || y1 <= y0) continue;

        const reds: number[] = [];
        const greens: number[] = [];
        const blues: number[] = [];
        const take = (x: number, y: number): void => {
            const offset = (y * bitmap.width + x) * 4;
            reds.push(pixels[offset]);
            greens.push(pixels[offset + 1]);
            blues.push(pixels[offset + 2]);
        };
        for (let x = x0; x <= x1; x += 1) {
            take(x, y0);
            take(x, y1);
        }
        for (let y = y0 + 1; y < y1; y += 1) {
            take(x0, y);
            take(x1, y);
        }

        const red = median(reds);
        const green = median(greens);
        const blue = median(blues);
        group.background = `rgb(${red}, ${green}, ${blue})`;
        // The label always carries a white stroke, so a white fill would disappear into it.
        group.color = '#111111';

        if (!textMask) continue;
        // The seg mask is the source of truth for glyphs, not the line box.
        // A box that spills outside a balloon therefore cannot paint the paper
        // outside it: only pixels the detector calls ink are in this image.
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
                if (inkAt(textMask, mx0 + x + 0.5, my0 + y + 0.5) < 0.3) continue;
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

async function runDetection(request: OffscreenDetectRequest): Promise<DetectResponse> {
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

        // One whole-page pass, as in the target project. Tiling was measured and
        // removed: it cost one full pass per tile for very little text gain.
        const detectStarted = performance.now();
        const detected = await detectBoxes(bitmap, balloonList.map((bubble) => ({
            x: bubble.x,
            y: bubble.y,
            width: bubble.width,
            height: bubble.height,
        })));
        timings.detect = Math.round(performance.now() - detectStarted);
        const ordered = toOrderedTextLines(detected.detBoxes, [], true);

        const groupStarted = performance.now();
        const grouped = groupByRegion(ordered, balloonList, [], false);

        const balloonRects = balloonList.map((bubble) => ({
            x: bubble.x,
            y: bubble.y,
            width: bubble.width,
            height: bubble.height,
        }));
        const lines = grouped.lines.map((line) => {
            const grown = { ...line, ...expandToInk(line, detected.mask, balloonRects) };
            // Ink past a balloon edge belongs to the next line. Keep the part
            // that started on this side of the edge, then follow det back out
            // from both ends until the mask runs out.
            const limited = stopAtBubbles(
                grown,
                line.x + line.width / 2,
                line.y + line.height / 2,
                balloonRects,
            );
            const restored = detected.det
                ? extendCutEnds(
                    limited,
                    detected.det,
                    { width: bitmap.width, height: bitmap.height },
                    grown.height >= grown.width,
                )
                : limited;
            return trimMergedRuby(restored, detected.mask);
        });
        timings.group = Math.round(performance.now() - groupStarted);

        const ocrStarted = performance.now();
        const collected = await recognizeLines(bitmap, suppressOverlaps(lines));
        timings.ocr = Math.round(performance.now() - ocrStarted);
        timings.extras = Math.round(performance.now() - started - timings.fetch - timings.detect - timings.group - timings.ocr);

        const thicknesses = collected
            .map((line) => Math.min(line.width, line.height))
            .filter((size) => size >= 4)
            .sort((left, right) => left - right);
        const medianThickness = thicknesses.length > 0 ? thicknesses[thicknesses.length >> 1] : 0;
        const usable = collected.filter((line) =>
            line.confidence >= OCR_MIN_CONFIDENCE
            && !skipAsNonDialogue(line, balloonList, medianThickness),
        );

        const groups: GroupData[] = [];
        const perGroup: string[][] = grouped.boxes.map(() => []);
        for (const line of usable) {
            for (let index = 0; index < grouped.boxes.length; index += 1) {
                if (!centreInsideBox(line, grouped.boxes[index])) continue;
                perGroup[index].push(line.text);
                break;
            }
        }
        grouped.boxes.forEach((box, index) => {
            const text = perGroup[index].filter((value) => value.length > 0);
            if (text.length > 0) groups.push({
                ...box,
                lines: text,
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

        paintGroupColours(bitmap, splitGroups, usable, detected.mask);

        const previews = cropPreviews(bitmap, collected.slice(0, MAX_PREVIEWS));

        const originalCanvas = document.createElement('canvas');
        originalCanvas.width = bitmap.width;
        originalCanvas.height = bitmap.height;
        const originalContext = originalCanvas.getContext('2d');
        originalContext?.drawImage(bitmap, 0, 0);
        const originalUrl = originalContext ? originalCanvas.toDataURL('image/webp', 0.95) : null;

        heldPage = null;
        if (detected.mask) {
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (context) {
                context.drawImage(bitmap, 0, 0);
                heldPage = {
                    image: context.getImageData(0, 0, canvas.width, canvas.height),
                    textMask: detected.mask,
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
            })),
            blocks: detected.blkBoxes.map((block) => ({
                x: block.x,
                y: block.y,
                width: block.width,
                height: block.height,
                score: block.score,
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
 * says where the ink is. AOT fills those pixels.
 */
async function runInpaint(request: OffscreenInpaintRequest): Promise<OffscreenInpaintResponse> {
    const page = heldPage;
    if (!page || request.boxes.length === 0) return { ok: true, erasedUrl: null };
    try {
        const lines = request.boxes.map((box) => ({ ...box, score: 1 }));
        const mask = refineMask(lines, page.textMask, page.image.width, page.image.height);
        let maskPixels = 0;
        for (const value of mask) if (value === 1) maskPixels += 1;
        if (maskPixels === 0) return { ok: true, erasedUrl: null };

        const painted = await inpaintPage(page.image, mask);
        const overlay = document.createElement('canvas');
        overlay.width = page.image.width;
        overlay.height = page.image.height;
        const overlayContext = overlay.getContext('2d');
        if (!overlayContext) return { ok: true, erasedUrl: null };
        const cutout = overlayContext.createImageData(page.image.width, page.image.height);
        for (let index = 0; index < mask.length; index += 1) {
            if (mask[index] !== 1) continue;
            const offset = index * 4;
            cutout.data[offset] = painted.data[offset];
            cutout.data[offset + 1] = painted.data[offset + 1];
            cutout.data[offset + 2] = painted.data[offset + 2];
            cutout.data[offset + 3] = 255;
        }
        overlayContext.putImageData(cutout, 0, 0);
        return { ok: true, erasedUrl: overlay.toDataURL('image/png') };
    } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
}

async function runBuiltinTranslate(lines: string[]): Promise<{ ok: true; texts: string[] } | { ok: false; error: string }> {
    if (!canTranslate()) {
        return { ok: false, error: 'This Chrome build does not expose the browser translator.' };
    }
    try {
        return { ok: true, texts: await translateAll(lines, 'ja', 'zh-Hant') };
    } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
}

// this is off the offscreen document
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const request = message as IncomingMessage | undefined;
    if (!request || request.target !== OFFSCREEN_TARGET) return false;

    if (request.type === 'ping') {
        sendResponse(serviceWorkerResponseFactory.ofPing());
        return false;
    }

    if (request.type === 'translate-builtin') {
        runBuiltinTranslate(request.lines).then(sendResponse);
        return true;
    }

    if (request.type === 'inpaint') {
        void runInpaint(request).then(sendResponse);
        return true;
    }

    void runDetection(request).then(sendResponse);
    return true;
});
