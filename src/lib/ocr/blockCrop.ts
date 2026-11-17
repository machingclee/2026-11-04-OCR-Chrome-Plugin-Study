/**
 * The crop a block is sent as: the BLK box with a small margin, upscaled to a
 * size at which a fine grid is legible, with the grid drawn on it.
 *
 * One function cuts it, so the image the reader sees, the image the debug view
 * shows and the cell mapping all agree on the same box and the same scale.
 */

import { gridCell, gridGeometry, paintGrid } from './grid';

/** Margin around a BLK box, in page pixels. */
export const BLOCK_PAD = 10;
/**
 * Extra margin on the top and the left, where the coordinate numbers are
 * printed. The numbers are four digits, so they need a strip of their own; drawn
 * over the block they would cover the edge of the column they describe.
 */
const RULER_LEFT = 22;
const RULER_TOP = 24;
/**
 * Short side the crop is upscaled to, so the grid's numbers are legible.
 *
 * Twice what it was: the grid is finer now (a cell of about 20 canvas pixels
 * rather than one character), and a fine grid on a small crop is a grey moire
 * over the text it is meant to help measure.
 */
const TARGET_SHORT_SIDE = 440;
/** Longest side the reader is sent, in pixels. */
const MAX_SIDE = 2000;
/** Upscale is capped here: beyond it the strokes turn to mush. */
const MAX_SCALE = 4;

export type BlockBox = { x: number; y: number; width: number; height: number };

/** How far the crop may grow past the block to show a box whole, per side. */
const GROW_SHARE = 0.6;
const GROW_MIN = 32;

/**
 * The padded box a block is cropped with, clamped to the page.
 *
 * A blk box can be tighter than the text it names, and a detector box that
 * reaches past it is still drawn on the crop. A box cut by the crop edge is
 * one the reader tends to skip, so the crop grows to hold every drawn box
 * whole, capped so one stray long box cannot turn the block into the page.
 */
export function blockCropBox(pageWidth: number, pageHeight: number, block: BlockBox, boxes: BlockBox[] = []): BlockBox {
    let x0 = block.x - BLOCK_PAD;
    let y0 = block.y - BLOCK_PAD;
    let x1 = block.x + block.width + BLOCK_PAD;
    let y1 = block.y + block.height + BLOCK_PAD;
    const growX = Math.max(GROW_MIN, block.width * GROW_SHARE);
    const growY = Math.max(GROW_MIN, block.height * GROW_SHARE);
    for (const box of boxes) {
        x0 = Math.max(block.x - growX, Math.min(x0, box.x));
        y0 = Math.max(block.y - growY, Math.min(y0, box.y));
        x1 = Math.min(block.x + block.width + growX, Math.max(x1, box.x + box.width));
        y1 = Math.min(block.y + block.height + growY, Math.max(y1, box.y + box.height));
    }
    const left = Math.max(0, Math.min(x0, x1 - 1));
    const top = Math.max(0, Math.min(y0, y1 - 1));
    return {
        x: left,
        y: top,
        width: Math.max(1, Math.min(pageWidth, x1) - left),
        height: Math.max(1, Math.min(pageHeight, y1) - top),
    };
}

/**
 * The box the reader is actually shown: the erase box, plus the strip the
 * coordinate numbers live in on the top and the left.
 *
 * Kept apart from `blockCropBox` on purpose. That box is also the area the
 * erase pass clears, and growing it to fit a ruler would have erased a strip of
 * artwork beside every block.
 */
export function readerCropBox(pageWidth: number, pageHeight: number, block: BlockBox, boxes: BlockBox[] = []): BlockBox {
    const box = blockCropBox(pageWidth, pageHeight, block, boxes);
    const left = Math.max(0, box.x - RULER_LEFT);
    const top = Math.max(0, box.y - RULER_TOP);
    return {
        x: left,
        y: top,
        width: Math.max(1, Math.min(pageWidth, box.x + box.width) - left),
        height: Math.max(1, Math.min(pageHeight, box.y + box.height) - top),
    };
}

/** Page pixels to crop pixels, which is the upscale the grid is drawn at. */
export function blockCropScale(crop: BlockBox): number {
    const short = Math.max(1, Math.min(crop.width, crop.height));
    const long = Math.max(crop.width, crop.height);
    return Math.min(MAX_SCALE, Math.max(1, TARGET_SHORT_SIDE / short), MAX_SIDE / long);
}

/**
 * The block's crop as a JPEG data URL, grid included. This is the intermediate
 * result between the detector and the reader: the image DeepSeek is asked
 * about.
 */
export function blockCropDataUrl(
    source: CanvasImageSource,
    pageWidth: number,
    pageHeight: number,
    block: BlockBox,
    /** Line boxes the detector found, drawn in blue as the text to read. */
    boxes: BlockBox[] = [],
): { dataUrl: string; crop: BlockBox; cell: number } {
    const crop = readerCropBox(pageWidth, pageHeight, block, boxes);
    const scale = blockCropScale(crop);
    const width = Math.max(1, Math.round(crop.width * scale));
    const height = Math.max(1, Math.round(crop.height * scale));
    const cell = gridCell(crop, scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The browser refused a 2D context for a block crop.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
    // The grid the answer is read off. It is drawn after the upscale, and its
    // numbers are page coordinates, so an answer needs no multiplication.
    paintGrid(context, width, height, gridGeometry(crop, cell), scale, { x: crop.x, y: crop.y });
    // The detector's line boxes, in blue: the prompt calls them the only text
    // to read, so handwriting beside a column is outside every box and stays
    // artwork. Each one carries a number, because asking where a line sits is a
    // measurement and a model measures badly — 20 page pixels out at best, a
    // column at worst. Naming which box a line is in is a choice, and the box
    // is already the ink.
    context.save();
    context.strokeStyle = 'rgba(29, 78, 216, 0.95)';
    context.lineWidth = Math.max(2, Math.round(scale * 1.4));
    const idSize = Math.max(9, Math.round(scale * 7));
    context.textBaseline = 'top';
    context.textAlign = 'left';
    context.font = `bold ${idSize}px "Helvetica Neue", Arial, sans-serif`;
    boxes.forEach((box, index) => {
        const left = (box.x - crop.x) * scale;
        const top = (box.y - crop.y) * scale;
        context.strokeRect(left, top, box.width * scale, box.height * scale);
        const label = String(index + 1);
        const room = context.measureText(label).width;
        // Above the corner, which is the crop's margin for the top row and the
        // gap between columns for the rest. Never on the glyphs.
        const chipX = Math.max(1, Math.min(left - room - 5, width - room - 4));
        const chipY = Math.max(1, Math.min(top - idSize - 4, height - idSize - 3));
        context.fillStyle = 'rgba(255, 255, 255, 0.92)';
        context.fillRect(chipX - 1, chipY - 1, room + 4, idSize + 2);
        context.fillStyle = '#15803d';
        context.fillText(label, chipX + 1, chipY);
    });
    context.restore();
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.92), crop, cell };
}
