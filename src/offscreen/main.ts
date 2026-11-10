import { detectBoxes, isSessionReady } from '../lib/detector';
import { cropPreviews } from '../lib/regions';
import { toOrderedTextLines } from '../lib/readingOrder';
import { recognizeLine } from '../lib/ocr/recognize';
import { OFFSCREEN_TARGET } from '../shared/constants';
import type {
    BoxData,
    DetectResponse,
    IncomingMessage,
    OffscreenDetectRequest,
} from '../shared/types';
import serviceWorkerResponseFactory from '../shared/factories/serviceWorkerResponseFactory';

const MAX_PREVIEWS = 60;

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
        const lines = toOrderedTextLines(detected.boxes, detected.blocks);
        const boxes: BoxData[] = [];
        for (const line of lines) {
            const recognised = await recognizeLine(bitmap, line, line.direction === 'vertical').catch(
                () => ({ text: '', confidence: 0 }),
            );
            boxes.push({ ...line, text: recognised.text, confidence: recognised.confidence });
        }
        const previews = cropPreviews(bitmap, boxes.slice(0, MAX_PREVIEWS));
        return {
            ok: true,
            boxes,
            previews,
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
