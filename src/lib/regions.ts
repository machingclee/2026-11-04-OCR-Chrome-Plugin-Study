import { eraseGlyphs } from './erase';
import { inpaintBox } from './inpaint';
import type { Box, BubbleMask, TextMask } from './types';

const PREVIEW_MAX_WIDTH = 160;
const PREVIEW_QUALITY = 0.8;

/**
 * Crop every box out of the decoded bitmap and return one preview per box.
 * With a mask the glyphs are removed first: the inpaint model redraws the paper
 * behind them, and the plain fill stays as the fallback when it is not loaded.
 */
export async function cropPreviews(
    bitmap: ImageBitmap,
    boxes: Box[],
    mask?: TextMask,
    bubbles?: BubbleMask,
): Promise<string[]> {
    if (boxes.length === 0) return [];

    if (mask) {
        const previews: string[] = [];
        for (const box of boxes) previews.push(await inpaintBox(bitmap, box, mask, bubbles));
        return previews;
    }

    const widest = Math.max(...boxes.map((box) => box.width));
    const scale = Math.min(1, PREVIEW_MAX_WIDTH / widest);

    return boxes.map((box) => {
        const width = Math.max(1, Math.round(box.width * scale));
        const height = Math.max(1, Math.round(box.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext('2d');
        if (!context) throw new Error('The browser refused a 2D context for the crop.');
        context.drawImage(bitmap, box.x, box.y, box.width, box.height, 0, 0, width, height);
        return canvas.toDataURL('image/webp', PREVIEW_QUALITY);
    });
}

export { eraseGlyphs };
