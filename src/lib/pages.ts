import type { Box } from './types';

/**
 * A scan can hold two pages side by side or stacked. The gutter between them is
 * a band with almost no ink, so it shows up as a cheap column or row profile.
 */
function gutter(profile: number[], from: number, to: number): number | null {
    const middle = Math.floor((from + to) / 2);
    const span = Math.floor((to - from) / 3);
    if (span < 8) return null;

    let bestIndex = -1;
    let bestValue = Infinity;
    for (let index = middle - span; index <= middle + span; index += 1) {
        if (index <= from || index >= to) continue;
        const value = profile[index];
        if (value < bestValue) {
            bestValue = value;
            bestIndex = index;
        }
    }

    let sum = 0;
    let count = 0;
    for (let index = from; index < to; index += 1) {
        sum += profile[index];
        count += 1;
    }
    const mean = count > 0 ? sum / count : 0;
    if (bestValue > mean * 0.35) return null;
    return bestIndex;
}

function columnInk(bitmap: ImageBitmap, column: number): number {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) return 0;
    context.drawImage(bitmap, column, 0, 1, bitmap.height, 0, 0, 1, bitmap.height);
    const data = context.getImageData(0, 0, 1, bitmap.height).data;
    let ink = 0;
    for (let index = 0; index < data.length; index += 4) {
        if (data[index] < 200) ink += 1;
    }
    return ink;
}

function rowInk(bitmap: ImageBitmap, row: number): number {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) return 0;
    context.drawImage(bitmap, 0, row, bitmap.width, 1, 0, 0, bitmap.width, 1);
    const data = context.getImageData(0, 0, bitmap.width, 1).data;
    let ink = 0;
    for (let index = 0; index < data.length; index += 4) {
        if (data[index] < 200) ink += 1;
    }
    return ink;
}

export type PageRect = { x: number; y: number; width: number; height: number };

/**
 * Find the pages inside one image. A wide image is cut at its widest gap, and a
 * long one is cut the same way, so each page is measured on its own.
 */
export function splitPages(bitmap: ImageBitmap): PageRect[] {
    const whole: PageRect = { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
    const wide = bitmap.width > bitmap.height * 1.15;
    const tall = bitmap.height > bitmap.width * 2.2;

    if (!wide && !tall) return [whole];

    if (wide) {
        const step = Math.max(1, Math.floor(bitmap.width / 240));
        const profile: number[] = [];
        for (let column = 0; column < bitmap.width; column += step) profile.push(columnInk(bitmap, column));
        const cut = gutter(profile, 0, profile.length - 1);
        if (cut !== null) {
            const x = cut * step;
            return [
                { x: 0, y: 0, width: x, height: bitmap.height },
                { x, y: 0, width: bitmap.width - x, height: bitmap.height },
            ];
        }
    }

    if (tall) {
        const step = Math.max(1, Math.floor(bitmap.height / 240));
        const profile: number[] = [];
        for (let row = 0; row < bitmap.height; row += step) profile.push(rowInk(bitmap, row));
        const cut = gutter(profile, 0, profile.length - 1);
        if (cut !== null) {
            const y = cut * step;
            return [
                { x: 0, y: 0, width: bitmap.width, height: y },
                { x: 0, y, width: bitmap.width, height: bitmap.height - y },
            ];
        }
    }

    return [whole];
}

/** Shift every box by the page offset so all coordinates stay page absolute. */
export function offsetBox<T extends Box>(box: T, page: PageRect): T {
    return { ...box, x: box.x + page.x, y: box.y + page.y };
}
