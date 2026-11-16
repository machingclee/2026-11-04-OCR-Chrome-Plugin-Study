/**
 * The crop a block is sent as: the BLK box with a small margin, upscaled, with
 * the grid drawn on it.
 *
 * One function cuts it, so the image the reader sees, the image the debug view
 * shows and the cell mapping all agree on the same box and the same scale.
 */

import { gridCell, gridGeometry, paintGrid } from './grid';

/** Margin around a BLK box, in page pixels. */
export const BLOCK_PAD = 10;
/** Short side the crop is upscaled to, so the grid's numbers are legible. */
const TARGET_SHORT_SIDE = 220;
/** Longest side the reader is sent, in pixels. */
const MAX_SIDE = 1600;

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

/** Page pixels to crop pixels, which is the upscale the grid is drawn at. */
export function blockCropScale(crop: BlockBox): number {
    const short = Math.max(1, Math.min(crop.width, crop.height));
    const long = Math.max(crop.width, crop.height);
    return Math.min(3, Math.max(1, TARGET_SHORT_SIDE / short), MAX_SIDE / long);
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
    const crop = blockCropBox(pageWidth, pageHeight, block, boxes);
    const scale = blockCropScale(crop);
    const width = Math.max(1, Math.round(crop.width * scale));
    const height = Math.max(1, Math.round(crop.height * scale));

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
    // The grid the answer is given in. It is drawn after the upscale, so a cell
    // edge lands on the same page pixel the mapping subtracts.
    paintGrid(context, width, height, gridGeometry(crop), scale);
    // The detector's line boxes, in blue: the prompt calls them the only text
    // to read, so handwriting beside a column is outside every box and stays
    // artwork.
    context.save();
    context.strokeStyle = 'rgba(29, 78, 216, 0.95)';
    context.lineWidth = Math.max(2, Math.round(scale * 1.4));
    for (const box of boxes) {
        context.strokeRect(
            (box.x - crop.x) * scale,
            (box.y - crop.y) * scale,
            box.width * scale,
            box.height * scale,
        );
    }
    context.restore();
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.92), crop, cell: gridCell(crop) };
}
