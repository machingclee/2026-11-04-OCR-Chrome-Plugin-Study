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
};

/** One speech balloon, in page pixels. */
export type BubbleData = {
    x: number;
    y: number;
    width: number;
    height: number;
    outline?: { x: number; y: number }[];
};

/** One reading group: the box that holds it and the text inside, line by line. */
export type GroupData = {
    x: number;
    y: number;
    width: number;
    height: number;
    lines: string[];
    /** Median colour of the paper around this group, as a CSS colour. */
    background?: string;
    /** A text colour that contrasts with the background. */
    color?: string;
    /** Glyph-shaped label image; painted pixels come from the seg mask. */
    maskUrl?: string;
    /** Where that image sits inside the group, in image pixels. */
    maskBox?: { x: number; y: number; width: number; height: number };
    /** Fall back to a rectangular fill only when no seg mask exists at all. */
    rectangle?: boolean;
    /** Original glyph thickness in image pixels, used for the label font size. */
    fontSize?: number;
};

/** One absolutely positioned translation, in the image's own pixels. */
export type OverlayItem = {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    vertical: boolean;
    /** Label colour sampled from the paper; defaults to white. */
    background?: string;
    color?: string;
    /** Glyph-shaped label image; when present it replaces the rectangular fill. */
    maskUrl?: string;
    maskBox?: { x: number; y: number; width: number; height: number };
    /** Only true when the detector supplied no seg mask. */
    rectangle?: boolean;
    /** Original glyph thickness in image pixels, used for the label font size. */
    fontSize?: number;
};

/** Popup to content script: place these boxes over the picked image. */
export type OverlayRequest = {
    /** The token stored when the image was picked. */
    token?: string;
    imageUrl: string;
    /** Natural image size; every item coordinate is in this space. */
    width: number;
    height: number;
    items: OverlayItem[];
    fontFamily: string;
    weight: 'normal' | 'bold';
    leading: number;
};

/** Content script to popup. */
export type OverlayResponse =
    | { ok: true; count: number }
    | { ok: false; error: string };

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
    | {
          ok: true;
          boxes: BoxData[];
          previews: string[];
          ms: number;
          warm: boolean;
          imageWidth: number;
          imageHeight: number;
          groupedLines: number;
          groups: GroupData[];
          bubbleError: string | null;
          bubbles: BubbleData[];
      }
    | { ok: false; error: string };

