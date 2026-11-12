import { INPAINT_MASK_GROW } from '../shared/constants';
import type { Box, TextMask } from './types';

const MODEL_SIZE = 1024;
const GLYPH = 0.25;

function segAt(mask: TextMask, pageX: number, pageY: number): number {
    const x = Math.round(pageX * mask.scale + mask.padX);
    const y = Math.round(pageY * mask.scale + mask.padY);
    if (x < 0 || y < 0 || x >= MODEL_SIZE || y >= MODEL_SIZE) return 0;
    return mask.data[y * MODEL_SIZE + x];
}

/** Grow a mask by a square kernel, which is how the target removes soft edges. */
function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
    if (!Number.isFinite(radius) || radius <= 0) return mask;
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (mask[y * width + x] === 0) continue;
            const y0 = Math.max(0, y - radius);
            const y1 = Math.min(height - 1, y + radius);
            const x0 = Math.max(0, x - radius);
            const x1 = Math.min(width - 1, x + radius);
            for (let ny = y0; ny <= y1; ny += 1) {
                for (let nx = x0; nx <= x1; nx += 1) out[ny * width + nx] = 1;
            }
        }
    }
    return out;
}

/**
 * Build one page sized mask from the seg map. Each line contributes the strokes
 * inside its own box, and the whole mask then grows, because a stroke leaves a
 * soft edge the threshold never reaches.
 */
export function refineMask(
    lines: Box[],
    mask: TextMask,
    pageWidth: number,
    pageHeight: number,
    allow?: (pageX: number, pageY: number) => boolean,
): Uint8Array {
    const raw = new Uint8Array(pageWidth * pageHeight);

    for (const line of lines) {
        const x0 = Math.max(0, Math.floor(line.x));
        const y0 = Math.max(0, Math.floor(line.y));
        const x1 = Math.min(pageWidth, Math.ceil(line.x + line.width));
        const y1 = Math.min(pageHeight, Math.ceil(line.y + line.height));
        for (let y = y0; y < y1; y += 1) {
            for (let x = x0; x < x1; x += 1) {
                if (segAt(mask, x + 0.5, y + 0.5) < GLYPH) continue;
                if (allow && !allow(x + 0.5, y + 0.5)) continue;
                raw[y * pageWidth + x] = 1;
            }
        }
    }

    const sizes = lines
        .map((line) => Math.min(line.width, line.height))
        .filter((size) => Number.isFinite(size) && size > 0);
    const textSize = sizes.length > 0
        ? sizes.reduce((sum, size) => sum + size, 0) / sizes.length
        : 12;
    const radius = Math.max(INPAINT_MASK_GROW, Math.round(textSize * 0.1) + 2);
    return dilate(raw, pageWidth, pageHeight, radius);
}
