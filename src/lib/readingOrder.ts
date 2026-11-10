import type { Box } from './detector';

/** Largest gap between two glyphs that still belong to the same line. */
const GLYPH_GAP = 8;

type Extent = { left: number; top: number; right: number; bottom: number };

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

function isNeighbour(a: Box, b: Box): boolean {
    const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width);
    const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height);
    return gapX <= GLYPH_GAP && gapY <= GLYPH_GAP;
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
 * a line, not a glyph, and a per-glyph box crops one character at a time.
 */
export function toTextLines(boxes: Box[]): Box[] {
    return groupNeighbours(boxes).map((group) => {
        const extent = extentOf(group);
        const score = group.reduce((sum, box) => sum + box.score, 0) / group.length;
        return {
            x: extent.left,
            y: extent.top,
            width: extent.right - extent.left,
            height: extent.bottom - extent.top,
            score,
        };
    });
}

/**
 * Manga reads top to bottom, and right to left when two lines start at the same
 * height. A tall group holds one column, so its members keep the detector order.
 */
export function orderForReading(lines: Box[]): Box[] {
    return [...lines].sort((a, b) => {
        const topA = Math.round(a.y / GLYPH_GAP);
        const topB = Math.round(b.y / GLYPH_GAP);
        if (topA !== topB) return topA - topB;
        return b.x + b.width - (a.x + a.width);
    });
}

/** One call for the offscreen document: glyph boxes in, ordered line boxes out. */
export function toOrderedTextLines(boxes: Box[]): Box[] {
    return orderForReading(toTextLines(boxes));
}
