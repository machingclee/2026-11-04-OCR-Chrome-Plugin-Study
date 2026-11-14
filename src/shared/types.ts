import { OFFSCREEN_TARGET, SERVICE_WORKER_TARGET } from './constants';

export type MessageTarget =
    | typeof SERVICE_WORKER_TARGET
    | typeof OFFSCREEN_TARGET;

export type MessageType = 'detect' | 'translate' | 'translate-batch' | 'batch-progress' | 'batch-status' | 'cancel-batch' | 'translate-builtin' | 'ping';

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
    /** Fetchable URL, or '' when only captured pixels are available. */
    imageUrl: string;
    /** Picked pixels, for pages that serve images from a blob: URL. */
    imageDataUrl?: string;
    tabPageUrl?: string;
};

/** One text block from the detector blk output, in page pixels. */
export type BlockData = {
    x: number;
    y: number;
    width: number;
    height: number;
    score: number;
};

/** One speech balloon, in page pixels. */
export type BubbleData = {
    x: number;
    y: number;
    width: number;
    height: number;
    outline?: { x: number; y: number }[];
    /** Median colour of the paper inside the balloon, sampled in the offscreen pass. */
    paper?: [number, number, number];
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
    /** True when the source lines are mostly vertical. */
    vertical?: boolean;
    /** True when the group came from a balloon rather than a block. */
    balloon?: boolean;
};

/** One absolutely positioned translation, in the image's own pixels. */
export type OverlayItem = {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    vertical: boolean;
    /** Radians. The box is the upright crop; the page rotates it around its centre. */
    angle?: number;
    /** All spans from one bubble share this id for group fitting. */
    groupId?: number;
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
    /** Balloon outline in image pixels; clips the label to the balloon. */
    clip?: { x: number; y: number }[];
    /** Fill the tight detected area instead of only the seg glyph pixels. */
    fill?: boolean;
    /** Paper patch over the original glyphs, separate from the text box. */
    patch?: { x: number; y: number; width: number; height: number };
};

/** Popup to content script: place these boxes over the picked image. */
export type OverlayRequest = {
    /** The token stored when the image was picked. */
    token?: string;
    imageUrl: string;
    /** Original page encoded as a data URL, used as an opaque base layer. */
    originalUrl?: string | null;
    /** Inpainted cutout, when the inpaint pass succeeded. */
    erasedUrl?: string | null;
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
    /** Picked pixels, for pages that serve images from a blob: URL. */
    imageDataUrl?: string;
};

export type OffscreenBuiltinTranslateRequest = {
    target: typeof OFFSCREEN_TARGET;
    type: 'translate-builtin';
    lines: string[];
};

/**
 * One page rectangle to erase. A box inside a balloon names the flat paper
 * behind its glyphs, so that rectangle is filled instead of inpainted; the
 * balloon outline keeps the fill off the wall.
 */
export type InpaintBox = {
    x: number;
    y: number;
    width: number;
    height: number;
    angle?: number;
    /** Paper colour behind these glyphs; when set, no model runs here. */
    paper?: [number, number, number];
    /** Balloon outline in image pixels. */
    clip?: { x: number; y: number }[];
};

/** Erase only these page rectangles. Sound effects never appear in the list. */
export type OffscreenInpaintRequest = {
    target: typeof OFFSCREEN_TARGET;
    type: 'inpaint';
    boxes: InpaintBox[];
};

export type OffscreenInpaintResponse =
    | { ok: true; erasedUrl: string | null }
    | { ok: false; error: string };

export type OffscreenBuiltinTranslateResponse =
    | { ok: true; texts: string[] }
    | { ok: false; error: string };

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
    | TranslateRequest
    | TranslateBatchRequest
    | BatchStatusRequest
    | CancelBatchRequest
    | OffscreenDetectRequest
    | OffscreenBuiltinTranslateRequest
    | OffscreenInpaintRequest
    | OffscreenPing;

/** Wall-clock cost of each stage, in milliseconds. */
export type DetectTimings = {
    fetch: number;
    detect: number;
    bubble: number;
    group: number;
    ocr: number;
    extras: number;
};

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
          /** Text blocks from the blk head. */
          blocks: BlockData[];
          erasedUrl: string | null;
          /** The seg map is still held, so a later pass can erase only the lines we translate. */
          canInpaint: boolean;
          /** Det score map painted back onto the page. Null when the plane was empty. */
          detUrl: string | null;
          /** Seg score map painted back onto the page. Null when the plane was empty. */
          segUrl: string | null;
          originalUrl: string | null;
          timings?: DetectTimings;
      }
    | { ok: false; error: string };



/** One translated region, enough for the popup to show the result. */
export type TranslationAnswer = {
    text: string;
    columns?: string[];
    skip?: boolean;
    type?: 'chat' | 'sfx';
};

export type TranslateSettings = {
    translator: 'gemini' | 'deepseek' | 'builtin';
    deepSeekKey: string;
    geminiKey: string;
    font: 'sans' | 'serif';
    leading: number;
    weight: 'normal' | 'bold';
};

/** Popup or content script to service worker: run the full image job. */
export type TranslateRequest = {
    target: typeof SERVICE_WORKER_TARGET;
    type: 'translate';
    /** Fetchable URL, or '' when only captured pixels are available. */
    imageUrl: string;
    /** Captured pixels, when the page gave no URL that can be fetched later. */
    imageDataUrl?: string;
    tabPageUrl?: string;
    tabId?: number;
    token?: string;
    settings?: TranslateSettings;
};

export type TranslateResponse =
    | {
          ok: true;
          count: number;
          used: string;
          active: 'gemini' | 'deepseek' | 'builtin';
          skipped: number;
          withBalloon: number;
          balloons: number;
          answers: TranslationAnswer[];
          ms: number;
          warm: boolean;
          timings?: DetectTimings;
      }
    | { ok: false; error: string };


/** A selected page kept for the debug viewer. Crops and mask images are left out. */
export type DebugPage = {
    token?: string;
    imageUrl: string;
    boxes: BoxData[];
    bubbles: BubbleData[];
    /** Blk boxes for this page. Absent on results saved before they were drawn. */
    blocks?: BlockData[];
    groups: GroupData[];
    ms: number;
    warm?: boolean;
    timings?: DetectTimings;
    /** Det score map for this page. Omitted when storage cannot hold the image. */
    detUrl?: string | null;
    /** Seg score map for this page. Omitted when storage cannot hold the image. */
    segUrl?: string | null;
    /** False until detection for this page has finished. */
    ready: boolean;
};

export type BatchItem = {
    imageUrl: string;
    token?: string;
    /**
     * Captured pixels for items whose image is a blob: URL. Kept in memory by
     * the service worker, because batch state is persisted to local storage.
     */
    imageDataUrl?: string;
};

export type BatchItemState = BatchItem & {
    status: 'pending' | 'running' | 'done' | 'error';
    error?: string;
    /** True when the pixels live only in memory and cannot survive a restart. */
    captured?: boolean;
};

export type BatchState = {
    id: string;
    tabId: number;
    status: 'running' | 'done' | 'cancelled';
    items: BatchItemState[];
    createdAt: number;
    updatedAt: number;
};

export type TranslateBatchRequest = {
    target: typeof SERVICE_WORKER_TARGET;
    type: 'translate-batch';
    items: BatchItem[];
    tabId?: number;
    settings?: TranslateSettings;
};

export type TranslateBatchResponse =
    | { ok: true; batchId: string; count: number }
    | { ok: false; error: string };

export type CancelBatchRequest = {
    target: typeof SERVICE_WORKER_TARGET;
    type: 'cancel-batch';
    batchId: string;
};

export type BatchStatusRequest = {
    target: typeof SERVICE_WORKER_TARGET;
    type: 'batch-status';
};

export type BatchStatusResponse = {
    running: boolean;
    batchId: string | null;
};

export type BatchProgressMessage = {
    type: 'batch-progress';
    state: BatchState;
};
