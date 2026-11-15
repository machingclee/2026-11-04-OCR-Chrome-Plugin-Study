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

    const sizes = boxes.map((box) => cropSize(box));
    const widest = Math.max(...sizes.map((size) => size.width));
    const scale = Math.min(1, PREVIEW_MAX_WIDTH / widest);

    return boxes.map((box, index) => {
        const size = sizes[index];
        // Draw at page scale first. The upright crop places the bitmap with
        // page coordinates, so a canvas that is already shrunk shows a slice
        // through the middle of the glyphs.
        const fullWidth = Math.max(1, Math.round(size.width));
        const fullHeight = Math.max(1, Math.round(size.height));
        const full = document.createElement('canvas');
        full.width = fullWidth;
        full.height = fullHeight;
        const fullContext = full.getContext('2d');
        if (!fullContext) throw new Error('The browser refused a 2D context for the crop.');
        drawUpright(fullContext, bitmap, box, fullWidth, fullHeight);

        if (mask) {
            const image = fullContext.getImageData(0, 0, fullWidth, fullHeight);
            eraseGlyphs(image, box, mask);
            fullContext.putImageData(image, 0, 0);
        }

        const width = Math.max(1, Math.round(fullWidth * scale));
        const height = Math.max(1, Math.round(fullHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('The browser refused a 2D context for the crop.');
        context.imageSmoothingEnabled = true;
        context.drawImage(full, 0, 0, width, height);
        return canvas.toDataURL('image/webp', PREVIEW_QUALITY);
    });
}

export { eraseGlyphs };
