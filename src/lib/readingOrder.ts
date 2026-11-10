import type { Box } from './detector';

/** Largest gap between two glyphs, as a fraction of the smaller glyph. */
const CHAR_GAP_TOLERANCE = 0.6;

export type TextDirection = 'vertical' | 'horizontal';

export type TextLine = Box & { direction: TextDirection };

type Extent = { left: number; top: number; right: number; bottom: number };

function charSize(box: Box): number {
    return Math.min(box.width, box.height);
}

function isNeighbour(a: Box, b: Box): boolean {
    const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width);
    const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height);
    const tolerance = CHAR_GAP_TOLERANCE * Math.min(charSize(a), charSize(b));
    return gapX <= tolerance && gapY <= tolerance;
}

function extentOf(boxes: Box[]): Extent {
    return boxes.reduce<Extent>(
        (extent, box) => ({
            left: Math.min(extent.left, box.x),
            top: Math.min(extent.top, box.y),
            right: Math.max(extent.right, box.x + box.width),
            bottom: Math.max(extent.bottom, box.y + box.height),
        }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
}

function contains(outer: Box, inner: Box): boolean {
    const inside =
        inner.x >= outer.x &&
        inner.y >= outer.y &&
        inner.x + inner.width <= outer.x + outer.width &&
        inner.y + inner.height <= outer.y + outer.height;
    return inside && inner.width * inner.height < outer.width * outer.height * 0.9;
}

/**
 * Drop boxes too small to hold a glyph, then boxes whose glyph is much smaller
 * than the page's typical one. A speck survives the first test and fails the second.
 */
export function dropNoise(boxes: Box[]): Box[] {
    const sized = boxes.filter((box) => box.width >= 3 && box.height >= 3);
    if (sized.length === 0) return sized;

    const sizes = sized.map(charSize).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)];
    const smallest = median * 0.3;

    const plausible = sized.filter((box) => charSize(box) >= smallest);
    return plausible.filter((box, index) =>
        !plausible.some((other, otherIndex) => otherIndex !== index && contains(other, box)),
    );
}

/** Join glyphs that sit close enough to belong to one line of text. */
function groupNeighbours(boxes: Box[]): Box[][] {
    const parent = boxes.map((_, index) => index);
    const find = (index: number): number => {
        if (parent[index] === index) return index;
        parent[index] = find(parent[index]);
        return parent[index];
    };

    for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
            if (!isNeighbour(boxes[i], boxes[j])) continue;
            parent[find(i)] = find(j);
        }
    }

    const groups = new Map<number, Box[]>();
    boxes.forEach((box, index) => {
        const key = find(index);
        const group = groups.get(key);
        if (group) group.push(box);
        else groups.set(key, [box]);
    });
    return [...groups.values()];
}

/**
 * Merge every group of neighbouring glyphs into one line box, because OCR reads
 * a line, not a glyph. A line taller than it is wide holds a vertical column.
 */
export function toTextLines(boxes: Box[]): TextLine[] {
    return groupNeighbours(boxes).map((group) => {
        const extent = extentOf(group);
        const width = extent.right - extent.left;
        const height = extent.bottom - extent.top;
        const score = group.reduce((sum, box) => sum + box.score, 0) / group.length;
        return {
            x: extent.left,
            y: extent.top,
            width,
            height,
            score,
            direction: height >= width ? 'vertical' : 'horizontal',
        };
    });
}

/**
 * Manga reads top to bottom, and right to left when two lines start at the same
 * height. Two horizontal lines in one row break that rule and read left to right.
 */
export function orderForReading(lines: TextLine[]): TextLine[] {
    const heights = lines.map((line) => line.height).sort((a, b) => a - b);
    const medianHeight = heights[Math.floor(heights.length / 2)] ?? 1;
    const rowBand = Math.max(1, medianHeight / 2);

    return [...lines].sort((a, b) => {
        const bandA = Math.round(a.y / rowBand);
        const bandB = Math.round(b.y / rowBand);
        if (bandA !== bandB) return bandA - bandB;

        if (a.direction === 'horizontal' && b.direction === 'horizontal') return a.x - b.x;
        return b.x + b.width - (a.x + a.width);
    });
}

/** One call for the offscreen document: glyph boxes in, ordered line boxes out. */
export function toOrderedTextLines(boxes: Box[]): TextLine[] {
    return orderForReading(toTextLines(dropNoise(boxes)));
}
