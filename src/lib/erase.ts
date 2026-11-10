import type { Box, TextMask } from './types';

const GLYPH_THRESHOLD = 0.3;
const BACKGROUND_THRESHOLD = 0.1;
const MODEL_SIZE = 1024;

/** Read the seg value that belongs to one pixel of a crop. */
function maskAt(mask: TextMask, box: Box, x: number, y: number, width: number, height: number): number {
    const pageX = box.x + ((x + 0.5) * box.width) / width;
    const pageY = box.y + ((y + 0.5) * box.height) / height;
    const sourceX = Math.round(pageX * mask.scale + mask.padX);
    const sourceY = Math.round(pageY * mask.scale + mask.padY);
    if (sourceX < 0 || sourceY < 0 || sourceX >= MODEL_SIZE || sourceY >= MODEL_SIZE) return 0;
    return mask.data[sourceY * MODEL_SIZE + sourceX];
}

/**
 * The bubble behind a line is mostly paper, so the median of the pixels the seg
 * map calls background gives its colour without reading the glyph edges.
 */
function backgroundColour(pixels: Uint8ClampedArray, values: Float32Array): [number, number, number] {
    const reds: number[] = [];
    const greens: number[] = [];
    const blues: number[] = [];

    for (let index = 0; index < values.length; index += 1) {
        if (values[index] > BACKGROUND_THRESHOLD) continue;
        const offset = index * 4;
        reds.push(pixels[offset]);
        greens.push(pixels[offset + 1]);
        blues.push(pixels[offset + 2]);
    }

    const median = (channel: number[]): number => {
        if (channel.length === 0) return 255;
        channel.sort((a, b) => a - b);
        return channel[channel.length >> 1];
    };

    return [median(reds), median(greens), median(blues)];
}

/**
 * Paint over every glyph pixel of one crop with the colour of the bubble behind
 * it. A pixel counts as a glyph when its own seg value passes the threshold, and
 * the mask grows by one pixel to catch the soft edge of the stroke.
 */
export function eraseGlyphs(image: ImageData, box: Box, mask: TextMask): void {
    const { width, height, data } = image;
    const values = new Float32Array(width * height);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            values[y * width + x] = maskAt(mask, box, x, y, width, height);
        }
    }

    const [red, green, blue] = backgroundColour(data, values);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            let glyph = false;
            for (let dy = -1; dy <= 1 && !glyph; dy += 1) {
                for (let dx = -1; dx <= 1; dx += 1) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                    if (values[ny * width + nx] > GLYPH_THRESHOLD) {
                        glyph = true;
                        break;
                    }
                }
            }
            if (!glyph) continue;

            const offset = (y * width + x) * 4;
            data[offset] = red;
            data[offset + 1] = green;
            data[offset + 2] = blue;
        }
    }
}
