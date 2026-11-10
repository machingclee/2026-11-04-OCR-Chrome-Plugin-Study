/** Every extension context receives every runtime message, so each one carries a target. */
export const SERVICE_WORKER_TARGET = 'service-worker';
export const OFFSCREEN_TARGET = 'offscreen';

export const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

/** Last successful result, readable by the popup after a restart of the popup. */
export const LAST_RESULT_KEY = 'lastDetection';

export type MessageTarget =
  | typeof SERVICE_WORKER_TARGET
  | typeof OFFSCREEN_TARGET;

export type MessageType = 'detect' | 'ping';

export type BoxData = {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
};

/** Popup to service worker. */
export type DetectRequest = {
  target: typeof SERVICE_WORKER_TARGET;
  type: 'detect';
  imageUrl: string;
  tabPageUrl?: string;
};

/** Service worker to offscreen document. */
export type OffscreenDetectRequest = {
  target: typeof OFFSCREEN_TARGET;
  type: 'detect';
  imageUrl: string;
};

/** Offscreen document to service worker. */
export type OffscreenPing = {
  target: typeof OFFSCREEN_TARGET;
  type: 'ping';
};

/**
 * Every message that can arrive through chrome.runtime.onMessage.
 * This is a union rather than one loose shape, so a listener that narrows on
 * target also narrows the fields: a renamed field then fails the build instead
 * of arriving as undefined.
 */
export type IncomingMessage =
  | DetectRequest
  | OffscreenDetectRequest
  | OffscreenPing;

export type DetectResponse =
  | { ok: true; boxes: BoxData[]; ms: number; warm: boolean }
  | { ok: false; error: string };
