import type { Box, TextMask } from './types';

const MODEL_SIZE = 1024;
const GLYPH = 0.25;
/** seg above this is a stroke, so a paper sample skips it. */
const GLYPH_PAPER = 0.3;
/** det above this is paint. Same floor the DET overlay paints from. */
const DET_PAINT = 0.05;

function segAt(mask: TextMask, pageX: number, pageY: number): number {
    const x = Math.round(pageX * mask.scale + mask.padX);
    const y = Math.round(pageY * mask.scale + mask.padY);
    if (x < 0 || y < 0 || x >= MODEL_SIZE || y >= MODEL_SIZE) return 0;
    return mask.data[y * MODEL_SIZE + x];
}

/**
 * Circular grow. kernelSize 3 reaches one pixel, matching the target project's
 * dilate: radius is half the kernel, and only pixels inside that circle are set.
 */
function dilate(mask: Uint8Array, width: number, height: number, kernelSize: number): Uint8Array {
    if (kernelSize <= 1) return mask.slice();
    const radius = Math.floor(kernelSize / 2);
    const limit = radius * radius + 0.25;
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (mask[y * width + x] === 0) continue;
            for (let dy = -radius; dy <= radius; dy += 1) {
                const ny = y + dy;
                if (ny < 0 || ny >= height) continue;
                const half = Math.floor(Math.sqrt(limit - dy * dy));
                const x0 = Math.max(0, x - half);
                const x1 = Math.min(width - 1, x + half);
                const row = ny * width;
                for (let nx = x0; nx <= x1; nx += 1) out[row + nx] = 1;
            }
        }
    }
    return out;
}

/**
 * Odd kernel. The page is scaled into a 512 square and thresholded, which
 * eats a one-pixel grow and pastes the original stroke back onto the edge.
 */
function lineKernel(textSize: number): number {
    const radius = Math.max(4, Math.round(textSize * 0.2));
    return radius * 2 + 1;
}

/** The page rectangle, or the same rectangle after it has been rotated about its centre. */
function coverageOf(line: Box): {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    hits: (x: number, y: number) => boolean;
} {
    const angle = line.angle ?? 0;
    if (Math.abs(angle) < 0.01) {
        return {
            x0: line.x,
            y0: line.y,
            x1: line.x + line.width,
            y1: line.y + line.height,
            hits: (x, y) => x >= line.x && x < line.x + line.width && y >= line.y && y < line.y + line.height,
        };
    }
    const centreX = line.x + line.width / 2;
    const centreY = line.y + line.height / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const halfWidth = line.width / 2;
    const halfHeight = line.height / 2;
    const corners = [
        [-halfWidth, -halfHeight],
        [halfWidth, -halfHeight],
        [halfWidth, halfHeight],
        [-halfWidth, halfHeight],
    ].map(([localX, localY]) => ({
        x: centreX + localX * cos - localY * sin,
        y: centreY + localX * sin + localY * cos,
    }));
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const corner of corners) {
        if (corner.x < x0) x0 = corner.x;
        if (corner.y < y0) y0 = corner.y;
        if (corner.x > x1) x1 = corner.x;
        if (corner.y > y1) y1 = corner.y;
    }
    return {
        x0,
        y0,
        x1,
        y1,
        hits: (x, y) => {
            const dx = x - centreX;
            const dy = y - centreY;
            const localX = dx * cos + dy * sin;
            const localY = -dx * sin + dy * cos;
            return Math.abs(localX) <= halfWidth && Math.abs(localY) <= halfHeight;
        },
    };
}

/**
 * Build one page sized mask from the seg map. Each line contributes the strokes
 * inside its own box, then grows by the target project's circular kernel, and
 * the combined mask grows by one more pixel. A leaned line uses the rotated
 * rectangle, so the strokes at either end are erased with the middle.
 */
export function refineMask(
    lines: Box[],
    mask: TextMask,
    pageWidth: number,
    pageHeight: number,
    allow?: (pageX: number, pageY: number) => boolean,
): Uint8Array {
    const raw = new Uint8Array(pageWidth * pageHeight);
    const covered = lines.map(coverageOf);

    for (const area of covered) {
        const x0 = Math.max(0, Math.floor(area.x0));
        const y0 = Math.max(0, Math.floor(area.y0));
        const x1 = Math.min(pageWidth, Math.ceil(area.x1));
        const y1 = Math.min(pageHeight, Math.ceil(area.y1));
        for (let y = y0; y < y1; y += 1) {
            for (let x = x0; x < x1; x += 1) {
                if (!area.hits(x + 0.5, y + 0.5)) continue;
                if (segAt(mask, x + 0.5, y + 0.5) < GLYPH) continue;
                if (allow && !allow(x + 0.5, y + 0.5)) continue;
                raw[y * pageWidth + x] = 1;
            }
        }
    }

    const grown = new Uint8Array(raw.length);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const area = covered[index];
        const textSize = Math.min(line.width, line.height);
        const kernel = lineKernel(textSize > 0 ? textSize : 12);
        const radius = Math.floor(kernel / 2);
        const x0 = Math.max(0, Math.floor(area.x0) - radius);
        const y0 = Math.max(0, Math.floor(area.y0) - radius);
        const x1 = Math.min(pageWidth, Math.ceil(area.x1) + radius);
        const y1 = Math.min(pageHeight, Math.ceil(area.y1) + radius);
        const cropWidth = x1 - x0;
        const cropHeight = y1 - y0;
        if (cropWidth <= 0 || cropHeight <= 0) continue;
        const local = new Uint8Array(cropWidth * cropHeight);
        for (let y = y0; y < y1; y += 1) {
            for (let x = x0; x < x1; x += 1) {
                if (raw[y * pageWidth + x] !== 1) continue;
                local[(y - y0) * cropWidth + (x - x0)] = 1;
            }
        }
        const dilated = dilate(local, cropWidth, cropHeight, kernel);
        for (let y = 0; y < cropHeight; y += 1) {
            for (let x = 0; x < cropWidth; x += 1) {
                if (dilated[y * cropWidth + x] !== 1) continue;
                grown[(y + y0) * pageWidth + (x + x0)] = 1;
            }
        }
    }
    // One more pixel on the combined mask, the target project's kernel of 3.
    return dilate(grown, pageWidth, pageHeight, 3);
}

function median(values: number[]): number {
    if (values.length === 0) return 255;
    values.sort((left, right) => left - right);
    return values[values.length >> 1];
}

/**
 * Median colour of the paper inside a page rectangle, leaving out every pixel
 * the seg plane calls a stroke.
 *
 * The old sample was a ring just outside the text. That ring is paper only while
 * the text keeps its distance from the balloon wall: a group whose columns fill
 * the balloon has the balloon outline on that ring, the outline is black, and
 * every label of that balloon got a black background. The paper behind the
 * glyphs is inside the box, between the strokes, so it is sampled there.
 */
export function paperColour(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
    rect: { x: number; y: number; width: number; height: number },
    mask: TextMask | null,
): [number, number, number] {
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(width - 1, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(height - 1, Math.ceil(rect.y + rect.height));
    if (x1 < x0 || y1 < y0) return [255, 255, 255];

    const reds: number[] = [];
    const greens: number[] = [];
    const blues: number[] = [];
    for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
            if (mask && segAt(mask, x + 0.5, y + 0.5) >= GLYPH_PAPER) continue;
            const offset = (y * width + x) * 4;
            reds.push(pixels[offset]);
            greens.push(pixels[offset + 1]);
            blues.push(pixels[offset + 2]);
        }
    }
    if (reds.length === 0) return [255, 255, 255];
    return [median(reds), median(greens), median(blues)];
}

/**
 * True when a page rectangle holds paint from either plane.
 *
 * The detector itself applies a mean-score floor, but every pass after it (merge
 * two boxes, cut a box into strips, fit it to the paint, grow it to the next
 * stroke) hands a child the parent's score. A box that was moved over empty
 * paper therefore survives to the overlay, which then annotates a silent stretch
 * of balloon or a sleeve. A line has to sit on paint to be a line.
 */
export function paintSamples(
    box: { x: number; y: number; width: number; height: number },
    det: TextMask | null,
    strokes: TextMask | null,
): number {
    if (!det && !strokes) return 0;
    const columns = 12;
    const rows = 12;
    let painted = 0;
    for (let row = 0; row < rows; row += 1) {
        const y = box.y + (box.height * (row + 0.5)) / rows;
        for (let column = 0; column < columns; column += 1) {
            const x = box.x + (box.width * (column + 0.5)) / columns;
            const onDet = det ? segAt(det, x, y) >= DET_PAINT : false;
            const onSeg = strokes ? segAt(strokes, x, y) >= GLYPH_PAPER : false;
            if (onDet || onSeg) painted += 1;
        }
    }
    return painted;
}
