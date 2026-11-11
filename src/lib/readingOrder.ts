import type { Box, Bubble, TextBlock, TextLine } from './types';

/** A host must be at least this much thicker than the box beside it. */
const RUBY_THICKNESS_RATIO = 1.6;
/**
 * A ruby spans a glyph or two, so its length stays close to the thickness of its
 * host. A whole column is many times longer and can never pass this test.
 */
const RUBY_MAX_LENGTH_RATIO = 1.6;
/** The host has to be a long line, not a blob. */
const RUBY_HOST_MIN_ELONGATION = 4;
/** The reading is shorter than its host but still a run of glyphs. */
const RUBY_GUEST_MIN_ELONGATION = 2;

/**
 * Below this share of surviving lines the block gate is treated as unreliable.
 * A dark page with white bubbles leaves the block head with very little, and its
 * two or three blocks then cover almost none of the text.
 */
const GATE_MIN_KEEP_RATIO = 0.75;


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

/** Length along the text direction: the long side of the box. */
function longerSide(box: Box): number {
    return Math.max(box.width, box.height);
}

/** How long a box is compared with how thick it is. */
function elongation(box: Box): number {
    return longerSide(box) / Math.max(1, smallerSide(box));
}

/** Whether two boxes run the same way, so one can annotate the other. */
function sameOrientation(a: Box, b: Box): boolean {
    return (a.height >= a.width) === (b.height >= b.width);
}

function gapBetween(a: Box, b: Box): { x: number; y: number } {
    return {
        x: Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width)),
        y: Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height)),
    };
}

/**
 * How much of a line sits inside a balloon. The centre alone is not enough when
 * two balloons overlap, and a box alone is too coarse for a round balloon.
 */
function overlapScore(bubble: Bubble, line: TextLine): number {
    const size = bubble.shapeSize;
    let hits = 0;
    let total = 0;

    for (let row = 0; row < 3; row += 1) {
        for (let column = 0; column < 3; column += 1) {
            const pageX = line.x + line.width * ((column + 0.5) / 3);
            const pageY = line.y + line.height * ((row + 0.5) / 3);
            total += 1;

            const x = Math.round(pageX * bubble.shapeScale + bubble.shapePadX);
            const y = Math.round(pageY * bubble.shapeScale + bubble.shapePadY);
            const inMask = x >= 0 && y >= 0 && x < size && y < size
                && bubble.shape[y * size + x] > 0.5;
            const inBox = pageX >= bubble.x && pageX <= bubble.x + bubble.width
                && pageY >= bubble.y && pageY <= bubble.y + bubble.height;
            if (inMask || inBox) hits += 1;
        }
    }

    return hits / total;
}

/** A region is either a balloon or a text block: both answer "text lives here". */
type Region = {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    cover: (line: TextLine) => boolean;
};

function regionOfBalloon(bubble: Bubble, index: number): Region {
    return {
        id: `balloon-${index}`,
        x: bubble.x,
        y: bubble.y,
        width: bubble.width,
        height: bubble.height,
        cover: (line) => overlapScore(bubble, line) >= 0.5,
    };
}

function regionOfBlock(block: TextBlock, index: number): Region {
    return {
        id: `block-${index}`,
        x: block.x,
        y: block.y,
        width: block.width,
        height: block.height,
        cover: (line) => centreInside(line, block),
    };
}

/**
 * Group the lines by the region that holds them. Blocks are the main source and
 * the balloons are the fallback, which is the order the target project uses.
 */
export function groupByRegion(
    lines: TextLine[],
    bubbles: Bubble[],
    blocks: TextBlock[],
    strict: boolean,
): { lines: TextLine[]; grouped: number; dropped: number; regions: number; boxes: Box[] } {
    // The target project prefers the block head and falls back to the balloons,
    // so the two never argue about which region a line belongs to.
    const regions: Region[] = blocks.length > 0
        ? blocks.map(regionOfBlock)
        : bubbles.map(regionOfBalloon);

    const groups = new Map<string, TextLine[]>();
    const loose: TextLine[] = [];

    for (const line of lines) {
        let best: Region | null = null;
        for (const region of regions) {
            if (!region.cover(line)) continue;
            if (!best || region.width * region.height < best.width * best.height) best = region;
        }
        if (!best) {
            loose.push(line);
            continue;
        }
        const bucket = groups.get(best.id);
        if (bucket) bucket.push(line);
        else groups.set(best.id, [line]);
    }

    const ordered: TextLine[] = [];
    const ids = [...groups.keys()].sort((a, b) => {
        const first = regions.find((region) => region.id === a) as Region;
        const second = regions.find((region) => region.id === b) as Region;
        const band = Math.max(first.height, second.height) * 0.35;
        if (Math.abs(first.y - second.y) > band) return first.y - second.y;
        return second.x + second.width - (first.x + first.width);
    });

    for (const id of ids) ordered.push(...(groups.get(id) as TextLine[]));
    const grouped = ordered.length;

    const boxes: Box[] = ids.map((id) => {
        const region = regions.find((item) => item.id === id) as Region;
        return { x: region.x, y: region.y, width: region.width, height: region.height, score: 1, angle: 0 };
    });

    if (strict) {
        return { lines: ordered, grouped, dropped: lines.length - grouped, regions: ids.length, boxes };
    }
    return { lines: ordered.concat(loose), grouped, dropped: 0, regions: ids.length, boxes };
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

            // Both boxes have to be lines. A blob over artwork is thick and short,
            // and it must never collect real columns as if they were readings.
            if (elongation(candidate) < RUBY_HOST_MIN_ELONGATION) continue;
            if (elongation(line) < RUBY_GUEST_MIN_ELONGATION) continue;

            // A ruby sits inside the span of its host, beside one or two glyphs.
            // A full column is long, so length keeps real text out of the pile.
            if (!sameOrientation(line, candidate)) continue;
            if (longerSide(line) > smallerSide(candidate) * RUBY_MAX_LENGTH_RATIO) continue;

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
export function toOrderedTextLines(
    detBoxes: Box[],
    blkBoxes: TextBlock[] = [],
    keepOutside = false,
): TextLine[] {
    const inside = keepOutside || blkBoxes.length === 0
        ? detBoxes
        : detBoxes.filter((box) => blkBoxes.some((block) => centreInside(box, block)));

    // A dark page gives the block head very little to work with. When the gate
    // would throw away most of the page, its evidence is weaker than the lines.
    const gateIsUseful = inside.length >= detBoxes.length * GATE_MIN_KEEP_RATIO;
    const kept = gateIsUseful ? inside : detBoxes;
    const merged = mergeAligned(dropNoise(kept));
    return orderForReading(separateRuby(toTextLines(merged)));
}
