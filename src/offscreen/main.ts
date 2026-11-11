import { detectBoxes, isSessionReady } from '../lib/detector';
import { detectBubbles } from '../lib/bubble';
import { cropPreviews } from '../lib/regions';
import { eraseGlyphs } from '../lib/erase';
import { expandToInk } from '../lib/expand';
import { offsetBox, splitPages } from '../lib/pages';
import { groupByRegion, toOrderedTextLines } from '../lib/readingOrder';
import { recognizeLine } from '../lib/ocr/recognize';
import { OFFSCREEN_TARGET } from '../shared/constants';
import type {
    BoxData,
    BubbleData,
    DetectResponse,
    GroupData,
    IncomingMessage,
    OffscreenDetectRequest,
} from '../shared/types';
import type { Box, TextMask } from '../lib/types';
import serviceWorkerResponseFactory from '../shared/factories/serviceWorkerResponseFactory';

/** Each crop is a data url in storage, so the strip stops at this many. */
const MAX_PREVIEWS = 30;

/** Whether a line centre sits inside a group box. */
function centreInsideBox(box: { x: number; y: number; width: number; height: number }, group: { x: number; y: number; width: number; height: number }): boolean {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    return x >= group.x && x <= group.x + group.width && y >= group.y && y <= group.y + group.height;
}
async function runDetection(request: OffscreenDetectRequest): Promise<DetectResponse> {
    const started = performance.now();
    const warm = isSessionReady();

    try {
        const response = await fetch(request.imageUrl, { credentials: 'include' });
        if (!response.ok) {
            return { ok: false, error: `Image fetch failed with ${response.status}.` };
        }

        const bitmap = await createImageBitmap(await response.blob());

        // A scan can hold two pages. Each page is measured on its own, so the
        // reading order never mixes the right page into the left one.
        const pages = splitPages(bitmap);
        const collected: BoxData[] = [];
        const balloons: BubbleData[] = [];
        let dropped = 0;
        let bubbleError: string | null = null;
        const groups: GroupData[] = [];
        const masks: {
            mask: TextMask;
            lines: Box[];
            balloons: {
                x: number;
                y: number;
                width: number;
                height: number;
                shape: Float32Array;
                shapeSize: number;
                shapeScale: number;
                shapePadX: number;
                shapePadY: number;
            }[];
        }[] = [];

        for (const page of pages) {
            const slice = pages.length === 1
                ? bitmap
                : await createImageBitmap(bitmap, page.x, page.y, page.width, page.height);

            // One 1024 square pass shrinks the page by 1024 / longest side. Tiling
            // lifts that back towards 1, so a small column keeps its strokes.
            let tilesX = Math.max(1, Math.ceil(slice.width / 1024));
            let tilesY = Math.max(1, Math.ceil(slice.height / 1024));
            while (tilesX * tilesY > 16) {
                if (tilesX >= tilesY) tilesX -= 1;
                else tilesY -= 1;
            }

            const detected = await detectBoxes(slice, tilesX, tilesY);
            const ordered = toOrderedTextLines(detected.detBoxes, [], true);
            const bubbles = await detectBubbles(slice).catch((cause: unknown) => {
                bubbleError = cause instanceof Error ? cause.message : String(cause);
                return null;
            });
            const grouped = groupByRegion(
                ordered,
                bubbles ? bubbles.bubbles : [],
                detected.blkBoxes,
                false,
            );
            dropped += grouped.dropped;
            const groupBoxes = grouped.boxes.map((box) => offsetBox(box, page));

            const lines = grouped.lines.map((line) => offsetBox(
                { ...line, ...expandToInk(line, detected.mask) },
                page,
            ));

            for (const bubble of bubbles ? bubbles.bubbles : []) {
                balloons.push({
                    x: bubble.x + page.x,
                    y: bubble.y + page.y,
                    width: bubble.width,
                    height: bubble.height,
                    outline: bubble.outline.map((point) => ({ x: point.x + page.x, y: point.y + page.y })),
                });
            }

            if (detected.mask) {
                masks.push({
                    mask: {
                        data: detected.mask.data,
                        scale: detected.mask.scale,
                        padX: detected.mask.padX - page.x * detected.mask.scale,
                        padY: detected.mask.padY - page.y * detected.mask.scale,
                    },
                    lines,
                    balloons: (bubbles ? bubbles.bubbles : []).map((bubble) => ({
                        x: bubble.x + page.x,
                        y: bubble.y + page.y,
                        width: bubble.width,
                        height: bubble.height,
                        shape: bubble.shape,
                        shapeSize: bubble.shapeSize,
                        shapeScale: bubble.shapeScale,
                        shapePadX: bubble.shapePadX - page.x * bubble.shapeScale,
                        shapePadY: bubble.shapePadY - page.y * bubble.shapeScale,
                    })),
                });
            }

            const perGroup: string[][] = groupBoxes.map(() => []);
            for (const line of lines) {
                const recognised = await recognizeLine(bitmap, line, line.direction === 'vertical')
                    .catch(() => ({ text: '', confidence: 0 }));
                collected.push({ ...line, text: recognised.text, confidence: recognised.confidence });

                const centreX = line.x + line.width / 2;
                const centreY = line.y + line.height / 2;
                for (let index = 0; index < groupBoxes.length; index += 1) {
                    const box = groupBoxes[index];
                    if (centreX < box.x || centreX > box.x + box.width) continue;
                    if (centreY < box.y || centreY > box.y + box.height) continue;
                    perGroup[index].push(recognised.text);
                    break;
                }
            }

            groupBoxes.forEach((box, index) => {
                const text = perGroup[index].filter((line) => line.length > 0);
                if (text.length === 0) return;
                groups.push({ ...box, lines: text });
            });

            // A line outside every region still has to be translated, so it
            // becomes a group of its own instead of being left out.
            for (const line of collected) {
                if (groups.some((group) => centreInsideBox(line, group))) continue;
                if (line.text.length === 0) continue;
                groups.push({
                    x: line.x,
                    y: line.y,
                    width: line.width,
                    height: line.height,
                    lines: [line.text],
                });
            }

        }

        // Erase at stroke level instead of filling a white box, so the artwork
        // behind the text survives.
        let erasedUrl: string | null = null;
        const maskUrl: string | null = null;
        if (masks.length > 0) {
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (context) {
                context.drawImage(bitmap, 0, 0);
                const image = context.getImageData(0, 0, canvas.width, canvas.height);
                // Erase at stroke level, and only inside the balloon that holds
                // the line, so the artwork beside a balloon keeps its strokes.
                for (const entry of masks) {
                    for (const line of entry.lines) {
                        const centreX = line.x + line.width / 2;
                        const centreY = line.y + line.height / 2;
                        const balloon = entry.balloons.find((item) =>
                            centreX >= item.x && centreX <= item.x + item.width
                            && centreY >= item.y && centreY <= item.y + item.height);
                        const allow = balloon
                            ? (pageX: number, pageY: number) => {
                                const x = Math.round(pageX * balloon.shapeScale + balloon.shapePadX);
                                const y = Math.round(pageY * balloon.shapeScale + balloon.shapePadY);
                                if (x < 0 || y < 0 || x >= balloon.shapeSize || y >= balloon.shapeSize) return false;
                                return balloon.shape[y * balloon.shapeSize + x] > 0.4;
                            }
                            : undefined;
                        eraseGlyphs(image, line, entry.mask, allow);
                    }
                }

                context.putImageData(image, 0, 0);
                erasedUrl = canvas.toDataURL('image/webp', 0.9);

            }
        }

        const previews = cropPreviews(bitmap, collected.slice(0, MAX_PREVIEWS));
        return {
            ok: true,
            boxes: collected,
            previews,
            imageWidth: bitmap.width,
            imageHeight: bitmap.height,
            groupedLines: collected.length - dropped,
            groups,
            bubbleError,
            erasedUrl,
            maskUrl,
            bubbles: balloons,
            ms: Math.round(performance.now() - started),
            warm
        };
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

    void runDetection(request).then(sendResponse);
    return true;
});
