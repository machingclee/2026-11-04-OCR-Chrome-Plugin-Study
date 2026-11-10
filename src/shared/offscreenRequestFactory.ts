import { OFFSCREEN_TARGET } from './constants';
import type { OffscreenDetectRequest, OffscreenPing } from './types';

/** Messages addressed to the offscreen document. */
function detect(imageUrl: string): OffscreenDetectRequest {
  return { target: OFFSCREEN_TARGET, type: 'detect', imageUrl };
}

/** Is a listener ready yet. */
function ping(): OffscreenPing {
  return { target: OFFSCREEN_TARGET, type: 'ping' };
}

const offscreenRequestFactory = { detect, ping };

export default offscreenRequestFactory;
