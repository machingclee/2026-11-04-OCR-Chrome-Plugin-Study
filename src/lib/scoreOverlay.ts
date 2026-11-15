import { DETECTOR_INPUT_SIZE } from '../shared/constants';
import type { TextMask } from './types';

/** Longest side of the stored preview. Full-page maps do not fit in extension storage. */
const MAX_SIDE = 384;
/** Scores below this stay transparent so the PNG stays small. */
const FLOOR = 0.05;

/**
 * Paint one detector plane back onto the page and return a compact image.
 * Alpha follows the score, so a weak response stays visible.
 */
export function renderScoreOverlay(
    map: TextMask,
    pageWidth: number,
    pageHeight: number,
    color: [number, number, number],
): string | null {
    if (pageWidth < 1 || pageHeight < 1) return null;
    const scaleDown = Math.min(1, MAX_SIDE / Math.max(pageWidth, pageHeight));
    const width = Math.max(1, Math.round(pageWidth * scaleDown));
    const height = Math.max(1, Math.round(pageHeight * scaleDown));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;

    const image = context.createImageData(width, height);
    const pixels = image.data;
    let written = 0;
    for (let y = 0; y < height; y += 1) {
        const pageY = ((y + 0.5) / height) * pageHeight;
        const srcY = Math.round(pageY * map.scale + map.padY);
        if (srcY < 0 || srcY >= DETECTOR_INPUT_SIZE) continue;
        for (let x = 0; x < width; x += 1) {
            const pageX = ((x + 0.5) / width) * pageWidth;
            const srcX = Math.round(pageX * map.scale + map.padX);
            if (srcX < 0 || srcX >= DETECTOR_INPUT_SIZE) continue;
            const score = map.data[srcY * DETECTOR_INPUT_SIZE + srcX] ?? 0;
            if (score < FLOOR) continue;
            const offset = (y * width + x) * 4;
            pixels[offset] = color[0];
            pixels[offset + 1] = color[1];
            pixels[offset + 2] = color[2];
            pixels[offset + 3] = Math.round(Math.min(1, score) * 210);
            written += 1;
        }
    }
    if (written === 0) return null;
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/webp', 0.7);
}
