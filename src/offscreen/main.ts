import { detectBoxes, isSessionReady } from '../lib/detector';
import { detectBubbles } from '../lib/bubble';
import { cropPreviews } from '../lib/regions';
import { expandToInk } from '../lib/expand';
import { groupByRegion, toOrderedTextLines } from '../lib/readingOrder';
import { recognizeLine } from '../lib/ocr/recognize';
import { OFFSCREEN_TARGET } from '../shared/constants';
import type {
    BoxData,
    DetectResponse,
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
        const detected = await detectBoxes(bitmap);
        // The block gate runs later, against the balloon masks, which are the
        // better evidence for "is this line inside a balloon".
        const ordered = toOrderedTextLines(detected.detBoxes, [], true);
        const bubbles = await detectBubbles(bitmap).catch(() => null);
        const grouped = groupByRegion(
            ordered,
            bubbles ? bubbles.bubbles : [],
            detected.blkBoxes,
            request.keepOutside !== true,
        );
        const lines = grouped.lines.map((line) => ({
            ...line,
            ...expandToInk(line, detected.mask),
        }));
        const boxes: BoxData[] = [];
        for (const line of lines) {
            const recognised = await recognizeLine(bitmap, line, line.direction === 'vertical').catch(
                () => ({ text: '', confidence: 0 }),
            );
            boxes.push({ ...line, text: recognised.text, confidence: recognised.confidence });
        }
        const previews = cropPreviews(bitmap, boxes.slice(0, MAX_PREVIEWS), detected.mask ?? undefined);
        return {
            ok: true,
            boxes,
            previews,
            imageWidth: bitmap.width,
            imageHeight: bitmap.height,
            // Only the outline crosses the message boundary. The mask is a
            // Float32Array, and JSON would turn its 25,600 cells into keys.
            groupedLines: grouped.grouped,
            bubbles: bubbles
                ? bubbles.bubbles.map((bubble) => ({
                      x: bubble.x,
                      y: bubble.y,
                      width: bubble.width,
                      height: bubble.height,
                  }))
                : [],
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
