import type { Box } from './detector';

export type TextMask = {
    data: Float32Array;
    scale: number;
    padX: number;
    padY: number;
};

function backgroundColour(pixels: Uint8ClampedArray, width: number, height: number): [number, number, number] {
    const counts = new Map<number, { count: number; r: number; g: number; b: number }>();

    const visit = (x: number, y: number): void => {
        const offset = (y * width + x) * 4;
        const r = pixels[offset];
        const g = pixels[offset + 1];
        const b = pixels[offset + 2];
        const key = (r >> 3) << 10 | (g >> 3) << 5 | b >> 3;
        const entry = counts.get(key);
        if (entry) {
            entry.count += 1;
            entry.r += r;
            entry.g += g;
            entry.b += b;
        } else {
            counts.set(key, { count: 1, r, g, b });
        }
    };

    for (let x = 0; x < width; x += 1) {
        visit(x, 0);
        visit(x, height - 1);
    }
    for (let y = 1; y < height - 1; y += 1) {
        visit(0, y);
        visit(width - 1, y);
    }

    let best = { count: 0, r: 255, g: 255, b: 255 };
    for (const entry of counts.values()) if (entry.count > best.count) best = entry;
    return [best.r / best.count, best.g / best.count, best.b / best.count];
}

/**
 * Paint over every text pixel of one line with the colour of the bubble behind
 * it. The detector's seg map says which pixels belong to a glyph.
 */
export function eraseLine(bitmap: ImageBitmap, box: Box, mask: TextMask): string {
    const width = Math.max(1, Math.round(box.width));
    const height = Math.max(1, Math.round(box.height));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The browser refused a 2D context for the erase.');

    context.drawImage(bitmap, box.x, box.y, box.width, box.height, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    const pixels = image.data;
    const [r, g, b] = backgroundColour(pixels, width, height);
    const modelSize = 1024;

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const sourceX = Math.round((box.x + (x + 0.5) * (box.width / width)) * mask.scale + mask.padX);
            const sourceY = Math.round((box.y + (y + 0.5) * (box.height / height)) * mask.scale + mask.padY);
            if (sourceX < 0 || sourceY < 0 || sourceX >= modelSize || sourceY >= modelSize) continue;
            if (mask.data[sourceY * modelSize + sourceX] < 0.3) continue;

            const offset = (y * width + x) * 4;
            pixels[offset] = r;
            pixels[offset + 1] = g;
            pixels[offset + 2] = b;
        }
    }

    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/webp', 0.8);
}
