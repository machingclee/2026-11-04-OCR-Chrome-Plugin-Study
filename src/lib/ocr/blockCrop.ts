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

/** The padded box a block is cropped with, clamped to the page. */
export function blockCropBox(pageWidth: number, pageHeight: number, block: BlockBox): BlockBox {
    const x = Math.max(0, block.x - BLOCK_PAD);
    const y = Math.max(0, block.y - BLOCK_PAD);
    return {
        x,
        y,
        width: Math.max(1, Math.min(pageWidth, block.x + block.width + BLOCK_PAD) - x),
        height: Math.max(1, Math.min(pageHeight, block.y + block.height + BLOCK_PAD) - y),
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
    const crop = blockCropBox(pageWidth, pageHeight, block);
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
