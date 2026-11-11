import type * as ort from 'onnxruntime-web/wasm';

export type Point = { x: number; y: number };

/** A line that may sit at any angle: the length follows the text, not the x axis. */
export type LineFrame = {
    origin: Point;
    /** Unit vector along the text. */
    along: Point;
    /** Unit vector across the text. */
    across: Point;
    length: number;
    thickness: number;
};

/** One axis aligned rectangle, in page pixels. */
export type Box = {
    x: number;
    y: number;
    width: number;
    height: number;
    score: number;
    /** Radians of the text direction, 0 when the line sits on the page axes. */
    angle?: number;
    /** Length along the text direction, which differs from width once angle is set. */
    lineLength?: number;
    /** Thickness across the text direction. */
    lineThickness?: number;
};

/** A text block from the blk output, which groups the lines of one bubble. */
export type TextBlock = { x: number; y: number; width: number; height: number; score: number };

/** The seg plane with the letterbox numbers needed to reach it. */
export type TextMask = { data: Float32Array; scale: number; padX: number; padY: number };

export type DetectionResult = { detBoxes: Box[]; blkBoxes: TextBlock[]; mask: TextMask | null };

/** The letterboxed tensor plus the mapping back to page pixels. */
export type Prepared = {
    tensor: ort.Tensor;
    scale: number;
    padX: number;
    padY: number;
    width: number;
    height: number;
};

export type TextDirection = 'vertical' | 'horizontal';

/** One line of text, with its own ruby and its reading direction. */
export type TextLine = Box & { direction: TextDirection; ruby: Box[] };

/** A union of every bubble mask, in the 640 grid the bubble model uses. */
export type BubbleMask = { data: Float32Array; scale: number; padX: number; padY: number; size: number };

/** What the recogniser returns for one line. */
export type OcrResult = { text: string; confidence: number };
