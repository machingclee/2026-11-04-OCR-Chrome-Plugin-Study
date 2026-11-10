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

/**
 * Shape of any message that arrives through chrome.runtime.onMessage.
 * Fields stay optional because the value crosses a boundary that carries no
 * type information, and each field keeps its concrete type rather than unknown.
 */
export type IncomingMessage = {
  target?: MessageTarget;
  type?: MessageType;
  url?: string;
  pageUrl?: string;
};

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
