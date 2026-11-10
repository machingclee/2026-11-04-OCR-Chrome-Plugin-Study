import type { Box, TextBlock, TextLine } from './types';

/** A host must be at least this much thicker than the box beside it. */
const RUBY_THICKNESS_RATIO = 1.6;

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


function centreInside(box: Box, block: TextBlock): boolean {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    return cx >= block.x && cx <= block.x + block.width && cy >= block.y && cy <= block.y + block.height;
}

function isTall(box: Box): boolean {
    return box.height >= box.width * 1.4;
}

function isWide(box: Box): boolean {
    return box.width >= box.height * 1.4;
}

/** Join two boxes only when they share one column and the gap stays short. */
export function mergeAligned(boxes: Box[]): Box[] {
    const merged = boxes.map((box) => ({ ...box }));
    let changed = true;

    while (changed) {
        changed = false;
        for (let i = 0; i < merged.length && !changed; i += 1) {
            for (let j = i + 1; j < merged.length; j += 1) {
                const a = merged[i];
                const b = merged[j];
                const vertical = isTall(a) && isTall(b);
                const horizontal = isWide(a) && isWide(b);
                if (!vertical && !horizontal) continue;

                const overlap = vertical
                    ? Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
                    : Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
                const thickness = vertical ? Math.min(a.width, b.width) : Math.min(a.height, b.height);
                const gap = vertical
                    ? Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height))
                    : Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
                if (overlap < thickness * 0.6 || gap > thickness * 0.7) continue;

                const left = Math.min(a.x, b.x);
                const top = Math.min(a.y, b.y);
                const right = Math.max(a.x + a.width, b.x + b.width);
                const bottom = Math.max(a.y + a.height, b.y + b.height);
                merged[i] = {
                    x: left,
                    y: top,
                    width: right - left,
                    height: bottom - top,
                    score: Math.max(a.score, b.score),
                };
                merged.splice(j, 1);
                changed = true;
                break;
            }
        }
    }

    return merged;
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
 * Separate the ruby lines from the body lines. The returned list holds body lines
 * only, and each of them carries the ruby that sat beside it, so nothing is lost
 * when the crop is cut.
 *
 * The test is relative: a box is ruby when the host beside it is at least 1.6
 * times as thick. A page median would break on a page that mixes sizes, and
 * vertical ruby is thin while horizontal ruby is short.
 */
export function separateRuby(lines: TextLine[]): TextLine[] {
    if (lines.length <= 1) return lines;

    // Thickest first, so a candidate can only be measured against lines that are
    // already accepted as text. A ruby line never becomes a host for real text.
    const byThickness = [...lines].sort((a, b) => smallerSide(b) - smallerSide(a));
    const hosts: TextLine[] = [];

    for (const line of byThickness) {
        const thickness = smallerSide(line);
        let host: TextLine | null = null;
        let nearest = Infinity;

        for (const candidate of hosts) {
            // The host has to be at least this much thicker than the candidate.
            // Vertical ruby is thin, horizontal ruby is short, so one ratio fits both.
            if (smallerSide(candidate) < thickness * RUBY_THICKNESS_RATIO) continue;

            // Ruby sits beside its host and never far away. The reach comes from
            // the host thickness, so it works above a row and right of a column.
            const gap = gapBetween(line, candidate);
            const distance = Math.max(gap.x, gap.y);
            if (distance > smallerSide(candidate) * 1.5) continue;
            if (distance < nearest) {
                nearest = distance;
                host = candidate;
            }
        }

        // A line with no host is ordinary text. A line with one leaves the list
        // and rides on its host, which keeps the crop free of the small kana.
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
export function toOrderedTextLines(detBoxes: Box[], blkBoxes: TextBlock[] = []): TextLine[] {
    const kept = blkBoxes.length === 0
        ? detBoxes
        : detBoxes.filter((box) => blkBoxes.some((block) => centreInside(box, block)));
    const merged = mergeAligned(dropNoise(kept));
    return orderForReading(separateRuby(toTextLines(merged)));
}
