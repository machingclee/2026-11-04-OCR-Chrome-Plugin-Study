/** Every extension context receives every runtime message, so each one carries a target. */
export const SERVICE_WORKER_TARGET = 'service-worker';
export const OFFSCREEN_TARGET = 'offscreen';

export const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

/** Last successful result, readable by the popup after a restart of the popup. */
export const LAST_RESULT_KEY = 'lastDetection';

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
  url: string;
  pageUrl?: string;
};

/** Service worker to offscreen document. */
export type OffscreenDetectRequest = {
  target: typeof OFFSCREEN_TARGET;
  type: 'detect';
  url: string;
};

/** Offscreen document to service worker. */
export type OffscreenPing = {
  target: typeof OFFSCREEN_TARGET;
  type: 'ping';
};

export type DetectResponse =
  | { ok: true; boxes: BoxData[]; ms: number; warm: boolean }
  | { ok: false; error: string };
