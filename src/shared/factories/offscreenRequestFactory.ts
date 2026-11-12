import { OFFSCREEN_TARGET } from '../constants';
import type { OffscreenBuiltinTranslateRequest, OffscreenDetectRequest, OffscreenPing } from '../types';

/** Messages addressed to the offscreen document. */
function ofDetection(imageUrl: string): OffscreenDetectRequest {
    return { target: OFFSCREEN_TARGET, type: 'detect', imageUrl };
}

/** Is a listener ready yet. */
function ofPing(): OffscreenPing {
    return { target: OFFSCREEN_TARGET, type: 'ping' };
}

function ofBuiltinTranslate(lines: string[]): OffscreenBuiltinTranslateRequest {
    return { target: OFFSCREEN_TARGET, type: 'translate-builtin', lines };
}

const offscreenRequestFactory = { ofDetection, ofPing, ofBuiltinTranslate };

export default offscreenRequestFactory;
