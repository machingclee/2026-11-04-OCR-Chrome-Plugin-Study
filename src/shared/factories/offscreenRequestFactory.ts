import { OFFSCREEN_TARGET } from '../constants';
import type { OcrRequest, OffscreenDetectRequest, OffscreenInpaintRequest, OffscreenPing } from '../types';

/** Messages addressed to the offscreen document. */
function ofDetection(imageUrl: string, imageDataUrl?: string, ocr?: OcrRequest): OffscreenDetectRequest {
    return {
        target: OFFSCREEN_TARGET,
        type: 'detect',
        imageUrl,
        ...(imageDataUrl ? { imageDataUrl } : {}),
        ...(ocr ? { ocr } : {}),
    };
}

/** Is a listener ready yet. */
function ofPing(): OffscreenPing {
    return { target: OFFSCREEN_TARGET, type: 'ping' };
}

function ofInpaint(boxes: OffscreenInpaintRequest['boxes']): OffscreenInpaintRequest {
    return { target: OFFSCREEN_TARGET, type: 'inpaint', boxes };
}

const offscreenRequestFactory = { ofDetection, ofPing, ofInpaint };

export default offscreenRequestFactory;
