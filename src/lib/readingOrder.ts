import type { Box, Bubble, TextBlock, TextLine } from './types';

/** A host must be at least this much thicker than the box beside it. */
const RUBY_THICKNESS_RATIO = 1.6;
/**
 * Furigana can run the full height of the word it annotates. It cannot run
 * longer than that host. A second column of dialogue is just as long, and the
 * thickness test is what keeps it.
 */
const RUBY_MAX_LENGTH_RATIO = 1.15;
/** The host has to be a long line, not a blob. A reading can be one kana. */
const RUBY_HOST_MIN_ELONGATION = 4;

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

/**
 * Join pieces of one line. A sword or a gap can leave a glyph as a square, so a
 * square still joins a column when it sits on the same x and the break is about
 * one stroke wide. Two tall columns side by side do not share that x, and two
 * wide lines only join along a row.
 */
export function mergeAligned(boxes: Box[]): Box[] {
    const merged = boxes.map((box) => ({ ...box }));
    let changed = true;

    while (changed) {
        changed = false;
        for (let i = 0; i < merged.length && !changed; i += 1) {
            for (let j = i + 1; j < merged.length; j += 1) {
                const a = merged[i];
                const b = merged[j];
                const xOverlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
                const yOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
                const yGap = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
                const xGap = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
                const minWidth = Math.min(a.width, b.width);
                const minHeight = Math.min(a.height, b.height);
                const sameColumn = xOverlap >= minWidth * 0.6;
                const sameRow = yOverlap >= minHeight * 0.6;
                const bothTall = isTall(a) && isTall(b);
                const columnLimit = minWidth * (bothTall ? 0.7 : 1.25);
                const stack = sameColumn && yGap <= columnLimit
                    && (isTall(a) || isTall(b) || yGap < minHeight);
                const join = sameRow && isWide(a) && isWide(b) && xGap <= minHeight * 0.7;
                if (!stack && !join) continue;

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

/**
 * How thick the strokes are. A slanted line's page-aligned box is wide even
 * when the glyphs are thin, so the rotated measurement is the one that counts.
 */
function strokeThickness(box: Box): number {
    if (box.lineLength && box.lineThickness && box.lineLength > 0 && box.lineThickness > 0) {
        return Math.min(box.lineLength, box.lineThickness);
    }
    return Math.min(box.width, box.height);
}

/** How long the line is along the slant, not along the page edge. */
function strokeLength(box: Box): number {
    if (box.lineLength && box.lineThickness && box.lineLength > 0 && box.lineThickness > 0) {
        return Math.max(box.lineLength, box.lineThickness);
    }
    return Math.max(box.width, box.height);
}

/** How long a box is compared with how thick its strokes are. */
function elongation(box: Box): number {
    return strokeLength(box) / Math.max(1, strokeThickness(box));
}

/** Page-aligned thickness, used only to decide how far a reading may sit. */
function crossSize(box: Box, vertical: boolean): number {
    return vertical ? box.width : box.height;
}

/** Shared span along the host, so a reading has to sit on that column. */
function alongOverlap(a: Box, b: Box, vertical: boolean): number {
    return vertical
        ? Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
        : Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
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
): { lines: TextLine[]; grouped: number; dropped: number; regions: number; boxes: Box[]; balloonFlags: boolean[] } {
    // A balloon is one speaker and one sentence, so it wins over the block that
    // surrounds it. A block is the fallback for text with no balloon at all.
    const balloons = bubbles.map(regionOfBalloon);
    const regions: Region[] = balloons.length > 0
        ? [...balloons, ...blocks.map(regionOfBlock)]
        : blocks.map(regionOfBlock);

    const groups = new Map<string, TextLine[]>();
    const loose: TextLine[] = [];

    for (const line of lines) {
        let best: Region | null = null;
        let fallback: Region | null = null;
        for (const region of regions) {
            if (!region.cover(line)) continue;
            if (region.id.startsWith('balloon-')) {
                if (!best || region.width * region.height < best.width * best.height) best = region;
            } else if (!fallback || region.width * region.height < fallback.width * fallback.height) {
                fallback = region;
            }
        }
        if (!best) best = fallback;
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
        return { lines: ordered, grouped, dropped: lines.length - grouped, regions: ids.length, boxes, balloonFlags: ids.map((id) => id.startsWith('balloon-')) };
    }
    return { lines: ordered.concat(loose), grouped, dropped: 0, regions: ids.length, boxes, balloonFlags: ids.map((id) => id.startsWith('balloon-')) };
}

/**
 * Separate the ruby lines from the body lines. The returned list holds body lines
 * only, and each of them carries the ruby that sat beside it, so nothing is lost
 * when the crop is cut.
 *
 * The test follows the host's strokes, not the page-aligned box. A slanted
 * column is wide on the page even when the glyphs are thin, so one kana beside
 * it would otherwise look like another column.
 */
export function separateRuby(lines: TextLine[]): TextLine[] {
    if (lines.length <= 1) return lines;

    // Thickest first, so a candidate can only be measured against lines that are
    // already accepted as text. A ruby line never becomes a host for real text.
    const byThickness = [...lines].sort((a, b) => strokeThickness(b) - strokeThickness(a));
    const hosts: TextLine[] = [];

    for (const line of byThickness) {
        let host: TextLine | null = null;
        let nearest = Infinity;

        for (const candidate of hosts) {
            // A blob over artwork is thick and short, and it must never collect
            // real columns as if they were readings.
            if (elongation(candidate) < RUBY_HOST_MIN_ELONGATION) continue;

            const vertical = candidate.height >= candidate.width;
            const guestVertical = line.height >= line.width;
            // A reading runs the same way as its host. A chapter title is a wide
            // line; the columns in the next panel are tall. Those are not ruby,
            // even when unclip makes the title thick enough to reach them.
            if (vertical !== guestVertical && elongation(line) >= 2) continue;

            const hostStroke = strokeThickness(candidate);
            const guestStroke = strokeThickness(line);
            // Vertical ruby has thinner strokes. Horizontal ruby does too.
            if (hostStroke < guestStroke * RUBY_THICKNESS_RATIO) continue;

            // A reading may span the whole word. A line longer than its host is
            // another column, not ruby. One kana is short, so it passes.
            if (strokeLength(line) > strokeLength(candidate) * RUBY_MAX_LENGTH_RATIO) continue;
            const overlap = alongOverlap(line, candidate, vertical);
            const guestAlong = vertical ? line.height : line.width;
            // A reading sits beside its word, so most of the reading overlaps the
            // host. Two columns that only meet at a corner are not ruby.
            if (overlap < guestAlong * 0.5) continue;

            const gap = gapBetween(line, candidate);
            const distance = vertical ? gap.x : gap.y;
            // Reach from the thinner stroke. A full-height display column is wide
            // enough that the old host-sized reach collected the next column.
            const reach = Math.min(hostStroke, guestStroke * 2, crossSize(candidate, vertical));
            if (distance > reach * 1.5) continue;
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
    keepOutside = true,
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

/**
 * A balloon detector can merge two touching balloons into one region. Lines in
 * one balloon overlap along their reading axis; two balloons leave a gap across
 * it. Split by connected components in both axes, so a diagonal pair does not
 * become one group just because the horizontal ranges overlap.
 */
export function splitGroupByColumnGap<T extends {
    x: number;
    y: number;
    width: number;
    height: number;
    direction?: 'vertical' | 'horizontal';
}>(
    group: { x: number; y: number; width: number; height: number },
    lines: T[],
    blocks: { x: number; y: number; width: number; height: number }[] = [],
): T[][] {
    const inside = lines.filter((line) => {
        const centreX = line.x + line.width / 2;
        const centreY = line.y + line.height / 2;
        return centreX >= group.x && centreX <= group.x + group.width
            && centreY >= group.y && centreY <= group.y + group.height;
    });
    if (inside.length < 2) return inside.length > 0 ? [inside] : [];

    const vertical = inside.filter((line) =>
        (line.direction ?? (line.height >= line.width ? 'vertical' : 'horizontal')) === 'vertical',
    ).length >= inside.length / 2;

    const parent = inside.map((_, index) => index);
    const find = (index: number): number => {
        let root = index;
        while (parent[root] !== root) root = parent[root];
        while (parent[index] !== index) {
            const next = parent[index];
            parent[index] = root;
            index = next;
        }
        return root;
    };
    const union = (left: number, right: number): void => {
        const a = find(left);
        const b = find(right);
        if (a !== b) parent[b] = a;
    };

    for (let left = 0; left < inside.length; left += 1) {
        for (let right = left + 1; right < inside.length; right += 1) {
            const a = inside[left];
            const b = inside[right];
            const gapX = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
            const gapY = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
            const thickness = vertical
                ? Math.min(a.width, b.width)
                : Math.min(a.height, b.height);
            const cross = vertical ? gapX : gapY;
            const along = vertical ? gapY : gapX;
            const crossLimit = Math.max(thickness * 0.6, 6);
            // Columns in one balloon overlap along the reading axis. A gap of
            // more than one line thickness is a new text band or a second
            // balloon, not another column of the same speech.
            const alongLimit = Math.max(thickness * 1.2, 12);
            if (cross <= crossLimit && along <= alongLimit) union(left, right);
        }
    }

    const groups = new Map<number, T[]>();
    inside.forEach((line, index) => {
        const root = find(index);
        const bucket = groups.get(root);
        if (bucket) bucket.push(line);
        else groups.set(root, [line]);
    });

    const clusters = [...groups.values()].map((cluster) => {
        cluster.sort((a, b) => {
            if (vertical) return (b.x + b.width / 2) - (a.x + a.width / 2);
            return a.y - b.y;
        });
        return cluster;
    });

    if (blocks.length === 0) return clusters;

    return clusters.flatMap((cluster) => {
        const buckets = new Map<number, T[]>();
        for (const line of cluster) {
            let best = -1;
            let bestArea = Number.POSITIVE_INFINITY;
            blocks.forEach((block, index) => {
                const centreX = line.x + line.width / 2;
                const centreY = line.y + line.height / 2;
                if (centreX < block.x || centreX > block.x + block.width) return;
                if (centreY < block.y || centreY > block.y + block.height) return;
                const area = block.width * block.height;
                if (area < bestArea) {
                    best = index;
                    bestArea = area;
                }
            });
            if (best < 0) return [cluster];
            const bucket = buckets.get(best);
            if (bucket) bucket.push(line);
            else buckets.set(best, [line]);
        }
        return buckets.size > 1 ? [...buckets.values()] : [cluster];
    });
}
