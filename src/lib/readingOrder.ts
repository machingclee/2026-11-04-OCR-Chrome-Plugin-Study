import type { Box } from './detector';

/** A host must be at least this much thicker than the box beside it. */
const RUBY_THICKNESS_RATIO = 1.6;

export type TextDirection = 'vertical' | 'horizontal';

export type TextLine = Box & { direction: TextDirection; ruby: Box[] };

function contains(outer: Box, inner: Box): boolean {
    const inside =
        inner.x >= outer.x &&
        inner.y >= outer.y &&
        inner.x + inner.width <= outer.x + outer.width &&
        inner.y + inner.height <= outer.y + outer.height;
    return inside && inner.width * inner.height < outer.width * outer.height * 0.5;
}

/**
 * Drop boxes too small to hold a glyph, and boxes that repeat a larger one. The
 * detector already returns one box per line, so nothing here joins boxes.
 */
export function dropNoise(boxes: Box[]): Box[] {
    const sized = boxes.filter((box) => box.width >= 4 && box.height >= 4);
    return sized.filter((box, index) =>
        !sized.some((other, otherIndex) => otherIndex !== index && contains(other, box)),
    );
}

/** A line taller than it is wide holds a vertical column. */
export function toTextLines(boxes: Box[]): TextLine[] {
    return boxes.map((box) => ({
        ...box,
        direction: box.height >= box.width ? 'vertical' : 'horizontal',
        ruby: [],
    }));
}

function smallerSide(box: Box): number {
    return Math.min(box.width, box.height);
}

function gapBetween(a: Box, b: Box): { x: number; y: number } {
    return {
        x: Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width)),
        y: Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height)),
    };
}

/**
 * Ruby is the small kana printed beside a kanji to give its reading. The
 * detector returns it as its own line, so it would sit in the strip as a
 * floating crop. Attach it to the line it annotates and keep the crop clean.
 *
 * The test is relative: a box is ruby when the host beside it is at least twice
 * as thick. A page median would break on a page that mixes sizes, and vertical
 * ruby is thin while horizontal ruby is short.
 */
export function attachRuby(lines: TextLine[]): TextLine[] {
    if (lines.length <= 1) return lines;

    const byThickness = [...lines].sort((a, b) => smallerSide(b) - smallerSide(a));
    const hosts: TextLine[] = [];

    for (const line of byThickness) {
        const thickness = smallerSide(line);
        let host: TextLine | null = null;
        let nearest = Infinity;

        for (const candidate of hosts) {
            if (smallerSide(candidate) < thickness * RUBY_THICKNESS_RATIO) continue;

            const gap = gapBetween(line, candidate);
            const distance = Math.max(gap.x, gap.y);
            if (distance > smallerSide(candidate) * 1.5) continue;
            if (distance < nearest) {
                nearest = distance;
                host = candidate;
            }
        }

        if (host) host.ruby.push({ ...line });
        else hosts.push(line);
    }

    return hosts;
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

/** One call for the offscreen document: detector boxes in, ordered lines out. */
export function toOrderedTextLines(boxes: Box[]): TextLine[] {
    return orderForReading(attachRuby(toTextLines(dropNoise(boxes))));
}
