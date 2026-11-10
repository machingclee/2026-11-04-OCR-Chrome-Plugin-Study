import type { Box } from './detector';

/** Largest vertical gap between two glyphs of one column. */
const VERTICAL_GAP_TOLERANCE = 0.6;

/** Largest horizontal gap between two glyphs of one row. */
const HORIZONTAL_GAP_TOLERANCE = 0.35;

/** Largest offset across the line that still counts as the same line. */
const ALIGN_TOLERANCE = 0.25;

/**
 * Two glyphs of very different sizes belong to different lines. The window is
 * wide because Japanese sets small kana such as っ and ゃ at about 70 percent of
 * the full size, and those glyphs still belong to their line.
 */
const SIZE_RATIO_TOLERANCE = 2.2;

export type TextDirection = 'vertical' | 'horizontal';

export type TextLine = Box & { direction: TextDirection };

type Extent = { left: number; top: number; right: number; bottom: number };

function charSize(box: Box): number {
    return Math.min(box.width, box.height);
}

function gapBetween(a: Box, b: Box): { x: number; y: number } {
    return {
        x: Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width),
        y: Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height),
    };
}

/**
 * Two glyphs join only when they line up. Glyphs of one column share an x, and
 * two columns sit further apart than two glyphs of one row, so the tight
 * horizontal tolerance keeps a column from swallowing its neighbour.
 */
function isNeighbour(a: Box, b: Box, scale: number): boolean {
    const smaller = Math.min(charSize(a), charSize(b));
    const larger = Math.max(charSize(a), charSize(b));
    if (larger > smaller * SIZE_RATIO_TOLERANCE) return false;

    const gap = gapBetween(a, b);
    const dx = Math.abs(a.x + a.width / 2 - (b.x + b.width / 2));
    const dy = Math.abs(a.y + a.height / 2 - (b.y + b.height / 2));

    const sameColumn = dx <= ALIGN_TOLERANCE * scale && gap.y <= VERTICAL_GAP_TOLERANCE * scale;
    const sameRow = dy <= ALIGN_TOLERANCE * scale && gap.x <= HORIZONTAL_GAP_TOLERANCE * scale;
    return sameColumn || sameRow;
}

/**
 * The size of a full glyph on this page. Ruby is small and often outnumbers the
 * text it annotates, so the upper quartile wins over the median: a page full of
 * furigana must not shrink the tolerance that joins the main glyphs.
 */
function pageScale(boxes: Box[]): number {
    const sizes = boxes.map(charSize).sort((a, b) => a - b);
    const upper = sizes.slice(Math.floor(sizes.length / 2));
    return upper[Math.floor(upper.length / 2)] ?? sizes[sizes.length - 1] ?? 1;
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
function groupNeighbours(boxes: Box[], scale: number): Box[][] {
    const parent = boxes.map((_, index) => index);
    const find = (index: number): number => {
        if (parent[index] === index) return index;
        parent[index] = find(parent[index]);
        return parent[index];
    };

    for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
            if (!isNeighbour(boxes[i], boxes[j], scale)) continue;
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
    const scale = pageScale(boxes);
    return groupNeighbours(boxes, scale).map((group) => {
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
