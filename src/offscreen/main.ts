import { detectBoxes, isSessionReady } from '../lib/detector';
import { detectBubbles } from '../lib/bubble';
import { cropPreviews } from '../lib/regions';
import { expandToInk } from '../lib/expand';
import { offsetBox, splitPages } from '../lib/pages';
import { groupByRegion, toOrderedTextLines } from '../lib/readingOrder';
import { recognizeLine } from '../lib/ocr/recognize';
import { OFFSCREEN_TARGET } from '../shared/constants';
import type {
    BoxData,
    DetectResponse,
    GroupData,
    IncomingMessage,
    OffscreenDetectRequest,
} from '../shared/types';
import serviceWorkerResponseFactory from '../shared/factories/serviceWorkerResponseFactory';

/** Each crop is a data url in storage, so the strip stops at this many. */
const MAX_PREVIEWS = 30;

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
        const balloons: { x: number; y: number; width: number; height: number }[] = [];
        let dropped = 0;
        const groups: GroupData[] = [];

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
            const bubbles = await detectBubbles(slice).catch(() => null);
            const grouped = groupByRegion(
                ordered,
                bubbles ? bubbles.bubbles : [],
                detected.blkBoxes,
                request.keepOutside !== true,
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
