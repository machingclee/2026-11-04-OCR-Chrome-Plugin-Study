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
    GroupData,
    IncomingMessage,
    OffscreenDetectRequest,
} from '../shared/types';
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

        // The page is one image. Tiling only raises the resolution the detector
        // sees; every box, mask and balloon still lives in this one space.
        let tilesX = Math.max(1, Math.ceil(bitmap.width / 1024));
        let tilesY = Math.max(1, Math.ceil(bitmap.height / 1024));
        while (tilesX * tilesY > 16) {
            if (tilesX >= tilesY) tilesX -= 1;
            else tilesY -= 1;
        }

        const detected = await detectBoxes(bitmap, tilesX, tilesY);
        const ordered = toOrderedTextLines(detected.detBoxes, [], true);
        let bubbleError: string | null = null;
        const bubbles = await detectBubbles(bitmap).catch((cause: unknown) => {
            bubbleError = cause instanceof Error ? cause.message : String(cause);
            return null;
        });

        const balloonList = bubbles ? bubbles.bubbles : [];
        const grouped = groupByRegion(ordered, balloonList, detected.blkBoxes, false);

        const lines = grouped.lines.map((line) => ({
            ...line,
            ...expandToInk(line, detected.mask),
        }));

        // The boxes are good, so the erase is simply a white fill of each one.
        // Balloon interiors are paper, so this is what a letterer would do: lift
        // the old text off the page, then set the new text in the same place.
        let erasedUrl: string | null = null;
        {
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context = canvas.getContext('2d');
            if (context) {
                context.drawImage(bitmap, 0, 0);
                context.fillStyle = '#ffffff';
                const pad = 2;
                for (const line of lines) {
                    context.fillRect(
                        line.x - pad,
                        line.y - pad,
                        line.width + pad * 2,
                        line.height + pad * 2,
                    );
                    for (const ruby of line.ruby) {
                        context.fillRect(
                            ruby.x - pad,
                            ruby.y - pad,
                            ruby.width + pad * 2,
                            ruby.height + pad * 2,
                        );
                    }
                }
                erasedUrl = canvas.toDataURL('image/webp', 0.92);
            }
        }

        const collected: BoxData[] = [];
        for (const line of lines) {
            const recognised = await recognizeLine(bitmap, line, line.direction === 'vertical').catch(
                () => ({ text: '', confidence: 0 }),
            );
            collected.push({ ...line, text: recognised.text, confidence: recognised.confidence });
        }

        const groups: GroupData[] = [];
        const perGroup: string[][] = grouped.boxes.map(() => []);
        for (const line of collected) {
            for (let index = 0; index < grouped.boxes.length; index += 1) {
                if (!centreInsideBox(line, grouped.boxes[index])) continue;
                perGroup[index].push(line.text);
                break;
            }
        }
        grouped.boxes.forEach((box, index) => {
            const text = perGroup[index].filter((value) => value.length > 0);
            if (text.length > 0) groups.push({ ...box, lines: text });
        });
        for (const line of collected) {
            if (groups.some((group) => centreInsideBox(line, group))) continue;
            if (line.text.length === 0) continue;
            groups.push({ x: line.x, y: line.y, width: line.width, height: line.height, lines: [line.text] });
        }

        const previews = cropPreviews(bitmap, collected.slice(0, MAX_PREVIEWS));

        return {
            ok: true,
            boxes: collected,
            previews,
            imageWidth: bitmap.width,
            imageHeight: bitmap.height,
            groupedLines: grouped.lines.length,
            groups,
            bubbleError,
            erasedUrl,
            bubbles: balloonList.map((bubble) => ({
                x: bubble.x,
                y: bubble.y,
                width: bubble.width,
                height: bubble.height,
                outline: bubble.outline,
            })),
            ms: Math.round(performance.now() - started),
            warm,
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
