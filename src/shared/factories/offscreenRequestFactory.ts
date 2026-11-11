import { OFFSCREEN_TARGET } from '../constants';
import type { OffscreenDetectRequest, OffscreenPing } from '../types';

/** Messages addressed to the offscreen document. */
function ofDetection(imageUrl: string, keepOutside?: boolean): OffscreenDetectRequest {
    return { target: OFFSCREEN_TARGET, type: 'detect', imageUrl, keepOutside };
}

/** Is a listener ready yet. */
function ofPing(): OffscreenPing {
    return { target: OFFSCREEN_TARGET, type: 'ping' };
}

const offscreenRequestFactory = { ofDetection, ofPing };

export default offscreenRequestFactory;
