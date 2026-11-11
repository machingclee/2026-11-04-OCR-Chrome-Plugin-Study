import { OFFSCREEN_TARGET, SERVICE_WORKER_TARGET } from './constants';

export type MessageTarget =
    | typeof SERVICE_WORKER_TARGET
    | typeof OFFSCREEN_TARGET;

export type MessageType = 'detect' | 'ping';

export type RubyBox = {
    x: number;
    y: number;
    width: number;
    height: number;
    score: number;
};

export type BoxData = {
    x: number;
    y: number;
    width: number;
    height: number;
    score: number;
    direction: 'vertical' | 'horizontal';
    /** Radians of the text direction, 0 when the line sits on the page axes. */
    angle?: number;
    lineLength?: number;
    lineThickness?: number;
    ruby: RubyBox[];
    text: string;
    confidence: number;
};

/** Popup to service worker. */
export type DetectRequest = {
    target: typeof SERVICE_WORKER_TARGET;
    type: 'detect';
    imageUrl: string;
    tabPageUrl?: string;
    keepOutside?: boolean;
};

/** Service worker to offscreen document. */
export type OffscreenDetectRequest = {
    target: typeof OFFSCREEN_TARGET;
    type: 'detect';
    imageUrl: string;
    keepOutside?: boolean;
};

/** Offscreen document to service worker. */
export type OffscreenPing = {
    target: typeof OFFSCREEN_TARGET;
    type: 'ping';
};

export type PingResponse = { ok: true };

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
    | { ok: true; boxes: BoxData[]; previews: string[]; ms: number; warm: boolean }
    | { ok: false; error: string };

