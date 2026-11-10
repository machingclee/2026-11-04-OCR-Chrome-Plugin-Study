import {
  OFFSCREEN_TARGET,
  type OffscreenDetectRequest,
  type OffscreenPing,
} from './messages';

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
