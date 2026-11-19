import { OFFSCREEN_TARGET, SERVICE_WORKER_TARGET } from './constants';
import type { OcrProvider, ReasoningEffort } from './constants';

export type MessageTarget =
    | typeof SERVICE_WORKER_TARGET
    | typeof OFFSCREEN_TARGET;

export type MessageType = 'detect' | 'translate' | 'translate-batch' | 'batch-progress' | 'batch-status' | 'cancel-batch' | 'ping';

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
    /** Translation written by the reading call, when it provided one. */
    translation?: string;
    confidence: number;
    /** The reader's classification: dialogue, a name or a sound effect. */
    kind?: 'chat' | 'sfx' | 'name';
    /**
     * The meaning printed as small text beside a katakana word (風の槍 beside
     * ヴィンドのスピア). Context for the translator, never drawn: it is the
     * gloss the katakana was coined from, not a reading of kanji.
     */
    gloss?: string;
    /**
     * The cell band the label fills inside its block, in page pixels. The
     * reader counted the block's cells, so the translation is spread over that
     * band instead of the guessed line box, which stays tight for erasing.
     */
    slot?: {
        x: number;
        y: number;
        width: number;
        height: number;
        /**
         * The frame stuck out of its block and was cut back to it. The label
         * uses this rectangle even when the line is leaned, because the lean
         * was measured on the part that is not text.
         */
        insideBlock?: boolean;
    };
};

/**
 * Who reads the text. The key is passed in the request because the offscreen
 * document has no access to the popup's settings.
 */
export type OcrRequest = {
    provider: OcrProvider;
    key: string;
    /** How long the reader may think. Omitted means the saved setting. */
    effort?: ReasoningEffort;
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
    /** Absent for the on-device recogniser. */
    ocr?: OcrRequest;
    /**
     * True for a debug detection: the detector runs, the reader does not. The
     * debug view wants the blk and det planes quickly, not the reading of every
     * block over the network.
     */
    local?: boolean;
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
    /** Translations of `lines`, when the reading call wrote them. */
    translations?: string[];
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
    /**
     * The frame each label is drawn on, in page pixels, parallel to `lines`: the
     * ink of the column the reader named. Kept on the group so a test can
     * compare the frame with the ink it was built from, without the layout.
     */
    frames?: { x: number; y: number; width: number; height: number }[];
    /** The ink box of each line, in page pixels, parallel to `lines`. */
    inks?: { x: number; y: number; width: number; height: number }[];
    /** The katakana gloss of each line, parallel to `lines`, when it has one. */
    glosses?: (string | undefined)[];
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
    /**
     * Extra space between characters, in em. A label with fewer characters
     * than the cells it has room for is spread across its band with this.
     */
    spacing?: number;
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
    /** Absent for the on-device recogniser. */
    ocr?: OcrRequest;
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
    /** Paper colour of the balloon the box sits in, when one was sampled. */
    paper?: [number, number, number];
    /**
     * 'line' for a det line box, where the image near the det band is text;
     * 'region' for any other box, where only the planes mark the text.
     */
    kind?: 'line' | 'region' | 'block';
    /** Rectangles inside a block whose ink stays, such as a sound effect. */
    keep?: { x: number; y: number; width: number; height: number }[];
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
    /**
     * What each model cost on this pass: its load (which includes the first
     * WebGPU shader compilation), its last run, and the device it ran on.
     */
    inference?: { label: string; backend: string; loadMs: number; runMs: number }[];
};

/** One block reading, as the debug view shows it: the box and the raw answer. */
export type BlockReadingData = {
    block: { x: number; y: number; width: number; height: number; score: number };
    raw: string;
    cropUrl?: string;
    /** The detector's line boxes drawn in blue on the crop the reader saw. */
    boxes?: { x: number; y: number; width: number; height: number }[];
    /** The translation this block produced, written back after the second pass. */
    translation?: string;
    regions: {
        x: number;
        y: number;
        width: number;
        height: number;
        text: string;
        direction: string;
        kind: string;
        /**
         * The reader's own page box for this column, kept when a detector box
         * was used as the frame. Absent when the reader did not report one.
         */
        characters?: { x: number; y: number; width: number; height: number };
    }[];
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
          /** One entry per block: the BLK box and the answer the reader gave for it. */
          blockReadings?: BlockReadingData[];
          erasedUrl: string | null;
          /** The seg map is still held, so a later pass can erase only the lines we translate. */
          canInpaint: boolean;
          /** Det score map painted back onto the page. Null when the plane was empty. */
          detUrl: string | null;
          /** Seg score map painted back onto the page. Null when the plane was empty. */
          segUrl: string | null;
          originalUrl: string | null;
          /** Who read the lines, when a cloud reader ran. */
          ocrProvider?: string;
          /** Lines the on-device model read. */
          ocrFallbacks?: number;
          /** Lines the cloud reader supplied text for. */
          ocrCloudLines?: number;
          /**
           * Every detected text region, whether or not it was translated. The
           * inpaint pass erases this set, so a line the reader or the translator
           * skipped does not leave its ink behind.
           */
          eraseBoxes?: { x: number; y: number; width: number; height: number; angle?: number; kind?: 'line' | 'region' }[];
          timings?: DetectTimings;
      }
    | { ok: false; error: string };



/** One translated region, enough for the popup to show the result. */
export type TranslationAnswer = {
    text: string;
    columns?: string[];
    skip?: boolean;
    type?: 'chat' | 'sfx' | 'name';
};

export type TranslateSettings = {
    translator: 'deepseek';
    deepSeekKey: string;
    /** How long DeepSeek may think, for the reading and the translation alike. */
    effort?: ReasoningEffort;
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
          active: 'deepseek';
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
    /** One preview per box, at debug size. Absent on pages saved before this. */
    previews?: string[];
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
