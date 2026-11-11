import { eraseGlyphs } from './erase';
import type { Box, TextMask } from './types';
import { cropSize, drawUpright } from './warp';

const PREVIEW_MAX_WIDTH = 140;
const PREVIEW_QUALITY = 0.72;

/**
 * Crop every box out of the decoded bitmap and return one preview per box.
 * With a mask the glyphs come out first, so the strip shows the page the way it
 * will look once the original text is gone.
 */
export function cropPreviews(bitmap: ImageBitmap, boxes: Box[], mask?: TextMask): string[] {
    if (boxes.length === 0) return [];

    const widest = Math.max(...boxes.map((box) => cropSize(box).width));
    const scale = Math.min(1, PREVIEW_MAX_WIDTH / widest);

    return boxes.map((box) => {
        const size = cropSize(box);
        const width = Math.max(1, Math.round(size.width * scale));
        const height = Math.max(1, Math.round(size.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext('2d');
        if (!context) throw new Error('The browser refused a 2D context for the crop.');
        drawUpright(context, bitmap, box, width, height);

        if (mask) {
            const image = context.getImageData(0, 0, width, height);
            eraseGlyphs(image, box, mask);
            context.putImageData(image, 0, 0);
        }

        return canvas.toDataURL('image/webp', PREVIEW_QUALITY);
    });
}

export { eraseGlyphs };
