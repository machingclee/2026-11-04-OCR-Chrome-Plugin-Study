import { OFFSCREEN_TARGET } from '../constants';
import type { OffscreenBuiltinTranslateRequest, OffscreenDetectRequest, OffscreenInpaintRequest, OffscreenPing } from '../types';

/** Messages addressed to the offscreen document. */
function ofDetection(imageUrl: string, imageDataUrl?: string): OffscreenDetectRequest {
    return imageDataUrl
        ? { target: OFFSCREEN_TARGET, type: 'detect', imageUrl, imageDataUrl }
        : { target: OFFSCREEN_TARGET, type: 'detect', imageUrl };
}

/** Is a listener ready yet. */
function ofPing(): OffscreenPing {
    return { target: OFFSCREEN_TARGET, type: 'ping' };
}

function ofBuiltinTranslate(lines: string[]): OffscreenBuiltinTranslateRequest {
    return { target: OFFSCREEN_TARGET, type: 'translate-builtin', lines };
}

function ofInpaint(boxes: OffscreenInpaintRequest['boxes']): OffscreenInpaintRequest {
    return { target: OFFSCREEN_TARGET, type: 'inpaint', boxes };
}

const offscreenRequestFactory = { ofDetection, ofPing, ofBuiltinTranslate, ofInpaint };

export default offscreenRequestFactory;
