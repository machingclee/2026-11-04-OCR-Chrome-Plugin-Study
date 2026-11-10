import type * as ort from 'onnxruntime-web/wasm';

/** One axis aligned rectangle, in page pixels. */
export type Box = { x: number; y: number; width: number; height: number; score: number };

/** A text block from the blk output, which groups the lines of one bubble. */
export type TextBlock = { x: number; y: number; width: number; height: number; score: number };

/** The seg plane with the letterbox numbers needed to reach it. */
export type TextMask = { data: Float32Array; scale: number; padX: number; padY: number };

export type DetectionResult = { boxes: Box[]; blocks: TextBlock[]; mask: TextMask | null };

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

/** What the recogniser returns for one line. */
export type OcrResult = { text: string; confidence: number };
