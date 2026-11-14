import { pathCrossesBubble } from './detector';
import type { Box, TextMask } from './types';

type PageRect = { x: number; y: number; width: number; height: number };

const MODEL_SIZE = 1024;
const STEP = 3;
const INK = 0.08;

function inkAt(mask: TextMask, pageX: number, pageY: number): number {
    const x = Math.round(pageX * mask.scale + mask.padX);
    const y = Math.round(pageY * mask.scale + mask.padY);
    if (x < 0 || y < 0 || x >= MODEL_SIZE || y >= MODEL_SIZE) return 0;
    return mask.data[y * MODEL_SIZE + x];
}

/** Strongest stroke response on the band of the line at one offset. */
function bandInk(mask: TextMask, box: Box, offset: number, side: 'start' | 'end', vertical: boolean): number {
    const samples = 9;
    let best = 0;
    for (let index = 0; index < samples; index += 1) {
        const fraction = (index + 0.5) / samples;
        if (vertical) {
            const x = box.x + box.width * fraction;
            const y = side === 'start' ? box.y - offset : box.y + box.height + offset;
            best = Math.max(best, inkAt(mask, x, y));
        } else {
            const y = box.y + box.height * fraction;
            const x = side === 'start' ? box.x - offset : box.x + box.width + offset;
            best = Math.max(best, inkAt(mask, x, y));
        }
    }
    return best;
}

/** How far the walk keeps clear of the end of a strip it tests against a box. */
const WALK_MARGIN = 4;

/**
 * True when the strip the walk has reached has entered another line's box. det
 * paints a big sound effect across its full height, so a horizontal walk can
 * follow that ink out of its own line and into the sound effect beside it. The
 * strip is tested short of its ends: two loose rows of one block overlap by a
 * pixel or two, and that is not a line standing in the way.
 */
function bandEntersBox(
    box: Box,
    offset: number,
    side: 'start' | 'end',
    vertical: boolean,
    obstacles: PageRect[],
): boolean {
    if (obstacles.length === 0) return false;
    const x = vertical ? box.x : (side === 'start' ? box.x - offset : box.x + box.width + offset);
    const y = vertical ? (side === 'start' ? box.y - offset : box.y + box.height + offset) : box.y;
    const width = vertical ? Math.max(1, box.width - WALK_MARGIN * 2) : 1;
    const height = vertical ? 1 : Math.max(1, box.height - WALK_MARGIN * 2);
    return obstacles.some((other) => x < other.x + other.width && x + width > other.x
        && y < other.y + other.height && y + height > other.y);
}

/**
 * Walk one end of a line outward while the mask keeps showing strokes, and jump
 * across the gap between two glyphs. The walk stops at the last stroke plus a
 * short window, so a column can grow by two or three glyphs but never reach the
 * column beside it.
 */
function grow(
    box: Box,
    mask: TextMask,
    side: 'start' | 'end',
    vertical: boolean,
    regions: PageRect[],
    obstacles: PageRect[],
): number {
    const thickness = vertical ? box.width : box.height;
    const maxExtra = Math.round(thickness * 3);
    const gapBudget = Math.round(thickness * 0.8);
    const originX = box.x + box.width / 2;
    const originY = box.y + box.height / 2;

    let lastInk = 0;
    for (let offset = STEP; offset <= maxExtra; offset += STEP) {
        const x = vertical ? originX : (side === 'start' ? box.x - offset : box.x + box.width + offset);
        const y = vertical ? (side === 'start' ? box.y - offset : box.y + box.height + offset) : originY;
        // The next stroke belongs to another balloon once the walk meets its edge.
        if (pathCrossesBubble(regions, originX, originY, x, y)) break;
        // ...and to another line once the strip reaches its box. A vertical walk
        // already stops at the balloon and at the gap budget; a horizontal one
        // follows det across the full height of a sound effect, so it is the one
        // that needs the boxes beside it.
        if (!vertical && bandEntersBox(box, offset, side, vertical, obstacles)) break;
        if (bandInk(mask, box, offset, side, vertical) >= INK) lastInk = offset;
        else if (offset - lastInk > gapBudget) break;
    }
    return lastInk;
}

/** Keep this much clear between two columns, so a fitted box never reads as merged. */
const ACROSS_GUTTER = 2;
/** How far a column may reach out for det on one side, as a share of its thickness. */
const ACROSS_GROW = 1;
/** Hard cap on that reach, in page pixels. */
const ACROSS_GROW_LIMIT = 32;
/** Most a column may trim from one side: enough for a loose margin, not a glyph. */
const ACROSS_TRIM = 0.6;
/** Hard cap on that trim, in page pixels. */
const ACROSS_TRIM_LIMIT = 24;
/** No line is trimmed below this width. */
const MIN_ACROSS = 4;
/** Samples down the column: one every this many page pixels. */
const BAND_STEP = 4;
/** Fewest and most samples a band takes, whatever the column height. */
const BAND_MIN = 8;
const BAND_MAX = 64;
/**
 * det below this is not paint. This is the floor the DET overlay paints from,
 * so the box edge and the orange blob end on the same pixel. The detector's own
 * accept level (0.25) is higher and sits inside the strokes, which is why a cut
 * there looks like it is hugging the seg strokes instead of the line.
 */
const DET_EDGE = 0.05;
/**
 * A band is inked when one sample clears the edge. A column is not a rectangle:
 * only the widest kana reaches the edge of the line, so demanding more than one
 * row cuts the box to the average stroke instead of the line.
 */
const DET_HITS = 1;
/**
 * det is the shrunken DBNet response: for a vertical column it is about half
 * the width of the strokes it marks. seg draws those strokes. The box covers
 * both, so an edge is only empty when neither plane paints there, and a cut can
 * never end up inside a glyph.
 */
const SEG_EDGE = 0.3;
/**
 * Empty page pixels that end a line. A wider strip is the next column, so
 * growth stops before it instead of jumping the gap to reach its ink.
 */
const ACROSS_GAP = 4;
/** Samples down the column when a balloon edge is tested. */
const WALL_SAMPLES = 5;

type Across = { low: number; high: number };

/**
 * The strip of free space on either side of one box edge. Every wall is found
 * against the boxes as they were first seen, never against a box that has
 * already moved, so the result does not depend on the order of the boxes.
 * `acrossX` fits the width of a column; the other axis fits the height.
 */
function wallsAcross(
    box: PageRect,
    index: number,
    boxes: PageRect[],
    page: PageRect,
    obstacles: PageRect[],
    acrossX: boolean,
): Across {
    const alongStart = acrossX ? box.y : box.x;
    const alongSize = acrossX ? box.height : box.width;
    const acrossStart = acrossX ? box.x : box.y;
    const acrossEnd = acrossStart + (acrossX ? box.width : box.height);
    let low = 0;
    let high = acrossX ? page.width : page.height;
    const siblings = boxes.slice(0, index).concat(boxes.slice(index + 1), obstacles);

    for (const other of siblings) {
        // Only a box that shares this line's own span is in the way. One that
        // sits beside it in the other direction is ground this walk never covers.
        const otherAlongStart = acrossX ? other.y : other.x;
        const otherAlongSize = acrossX ? other.height : other.width;
        const shared = Math.min(alongStart + alongSize, otherAlongStart + otherAlongSize)
            - Math.max(alongStart, otherAlongStart);
        if (shared <= 1) continue;
        const otherStart = acrossX ? other.x : other.y;
        const otherEnd = otherStart + (acrossX ? other.width : other.height);
        if (otherStart >= acrossEnd) {
            // Split the gap instead of handing it to one side: both boxes may
            // grow, and neither can cross the other.
            const wall = (otherStart + acrossEnd) / 2 - ACROSS_GUTTER / 2;
            high = Math.min(high, Math.max(acrossEnd, wall));
        } else if (otherEnd <= acrossStart) {
            const wall = (otherEnd + acrossStart) / 2 + ACROSS_GUTTER / 2;
            low = Math.max(low, Math.min(acrossStart, wall));
        } else {
            // The two already overlap. There is no free strip between them.
            low = acrossStart;
            high = acrossEnd;
        }
    }
    return { low, high };
}

/** True when one step across a line has entered or left a balloon. */
function crossesBalloon(
    regions: PageRect[],
    centreX: number,
    centreY: number,
    candidate: number,
    alongStart: number,
    alongSize: number,
    acrossX: boolean,
): boolean {
    for (let sample = 0; sample < WALL_SAMPLES; sample += 1) {
        const along = alongStart + (alongSize * (sample + 0.5)) / WALL_SAMPLES;
        const x = acrossX ? candidate : along;
        const y = acrossX ? along : candidate;
        if (pathCrossesBubble(regions, centreX, centreY, x, y)) return true;
    }
    return false;
}

/** How many samples along the line still show paint at this across coordinate. */
function bandHits(
    det: TextMask,
    strokes: TextMask | null,
    candidate: number,
    alongStart: number,
    alongSize: number,
    acrossX: boolean,
): number {
    const span = Math.max(1, alongSize);
    const steps = Math.max(BAND_MIN, Math.min(BAND_MAX, Math.round(span / BAND_STEP)));
    let hits = 0;
    for (let index = 0; index < steps; index += 1) {
        const along = alongStart + (span * (index + 0.5)) / steps;
        const x = acrossX ? candidate : along;
        const y = acrossX ? along : candidate;
        if (inkAt(det, x, y) >= DET_EDGE) hits += 1;
        else if (strokes && inkAt(strokes, x, y) >= SEG_EDGE) hits += 1;
    }
    return hits;
}

/**
 * The furthest one edge may travel before a balloon wall or the wall another box
 * owns stops it. Page pixels, one at a time, so the stop is immediate.
 */
function travel(
    from: number,
    direction: -1 | 1,
    reach: number,
    wall: number,
    regions: PageRect[],
    centreX: number,
    centreY: number,
    alongStart: number,
    alongSize: number,
    acrossX: boolean,
): number {
    const limit = direction < 0 ? Math.max(wall, from - reach) : Math.min(wall, from + reach);
    let at = from;
    while (direction < 0 ? at > limit : at < limit) {
        const next = at + direction;
        if (crossesBalloon(regions, centreX, centreY, next, alongStart, alongSize, acrossX)) break;
        at = next;
    }
    return at;
}

/**
 * The detector stops short of the strokes, or runs past them into the margin, so
 * the box does not match the line it belongs to. Both edges of one axis follow
 * paint: they reach out while either plane still shows the line and cut in where
 * neither does, bounded by the box beside them, the balloon edge, the page, and
 * a budget in each direction. The cut lands on the paint itself, so white margin
 * goes and no glyph is clipped, and the budget only bounds a wrong answer.
 */
function fitAxis<T extends Box>(
    box: T,
    index: number,
    boxes: PageRect[],
    page: PageRect,
    det: TextMask,
    strokes: TextMask | null,
    regions: PageRect[],
    obstacles: PageRect[],
    acrossX: boolean,
): T {
    // Growing the page rectangle of a leaned hull would flatten it.
    if (Math.abs(box.angle ?? 0) >= 0.01) return box;

    const thickness = acrossX ? box.width : box.height;
    const grow = Math.min(ACROSS_GROW_LIMIT, Math.max(2, Math.round(thickness * ACROSS_GROW)));
    const trim = Math.min(ACROSS_TRIM_LIMIT, Math.max(3, Math.round(thickness * ACROSS_TRIM)));
    const { low: wallLow, high: wallHigh } = wallsAcross(box, index, boxes, page, obstacles, acrossX);

    const alongStart = acrossX ? box.y : box.x;
    const alongSize = acrossX ? box.height : box.width;
    const centreX = box.x + box.width / 2;
    const centreY = box.y + box.height / 2;
    const thisLow = acrossX ? box.x : box.y;
    const thisHigh = thisLow + thickness;

    const reachLow = travel(thisLow, -1, grow, wallLow, regions, centreX, centreY, alongStart, alongSize, acrossX);
    // The walls are exclusive bounds; the edges below are inclusive page pixels.
    const reachHigh = travel(thisHigh - 1, 1, grow, wallHigh - 1, regions, centreX, centreY, alongStart, alongSize, acrossX);

    const paint = (at: number): boolean =>
        bandHits(det, strokes, at, alongStart, alongSize, acrossX) >= DET_HITS;

    // Follow the ink that touches the box edge. A strip wider than ACROSS_GAP
    // is the next line, so the walk stops before it: growing onto an ellipsis
    // column two glyphs away would fuse two lines into one box.
    const outward = (edge: number, direction: -1 | 1, reach: number): number => {
        let best: number | null = paint(edge) ? edge : null;
        let empty = 0;
        let at = edge;
        while (empty <= ACROSS_GAP) {
            const next = at + direction;
            if (direction < 0 ? next < reach : next > reach) break;
            at = next;
            if (paint(at)) {
                best = at;
                empty = 0;
            } else {
                empty += 1;
            }
        }
        return best ?? edge;
    };
    // An edge with no ink at all is empty margin, so the box cuts in to its ink.
    const inward = (edge: number, direction: -1 | 1, limit: number): number => {
        let at = edge;
        while (direction < 0 ? at > limit : at < limit) {
            at += direction;
            if (paint(at)) return at;
        }
        return edge;
    };

    const lowEdge = thisLow;
    const highEdge = thisHigh - 1;
    let low = outward(lowEdge, -1, reachLow);
    if (low === lowEdge && !paint(lowEdge)) {
        low = inward(lowEdge, 1, Math.min(lowEdge + trim, highEdge));
    }
    let high = outward(highEdge, 1, reachHigh);
    if (high === highEdge && !paint(highEdge)) {
        high = inward(highEdge, -1, Math.max(highEdge - trim, lowEdge));
    }

    // One box is one ink column. If the edges ended up much wider than the ink
    // the box sits on — two columns fused upstream, or a walk that jumped a gap
    // — pull them back to that ink, so no box can swallow its neighbour.
    // Only the thin side: a long side is allowed to run across the gaps in its
    // own letters, which is how spaced SFX and large type are drawn.
    const thinAxis = (box.height >= box.width) === acrossX;
    const centre = Math.round((low + high) / 2);
    // A box that straddles the gap between two lines has no ink at its centre,
    // so the anchor is the nearest ink column either side.
    let anchor = centre;
    if (thinAxis && !paint(anchor)) {
        for (let step = 1; step <= thickness; step += 1) {
            if (centre - step >= low && paint(centre - step)) { anchor = centre - step; break; }
            if (centre + step <= high && paint(centre + step)) { anchor = centre + step; break; }
        }
    }
    if (thinAxis && paint(anchor)) {
        const run = (direction: -1 | 1, limit: number): number => {
            let best = anchor;
            let empty = 0;
            let at = anchor;
            while (empty <= ACROSS_GAP) {
                const next = at + direction;
                if (direction < 0 ? next < limit : next > limit) break;
                at = next;
                if (paint(at)) {
                    best = at;
                    empty = 0;
                } else {
                    empty += 1;
                }
            }
            return best;
        };
        const runLow = run(-1, reachLow);
        const runHigh = run(1, reachHigh);
        if ((high - low + 1) > (runHigh - runLow + 1) * 1.5) {
            low = runLow;
            high = runHigh;
        }
    }

    // Edges are inclusive page pixels, so the width keeps the last painted column.
    if (high - low + 1 < MIN_ACROSS) return box;
    if (low === lowEdge && high === highEdge) return box;
    return acrossX
        ? { ...box, x: low, width: high - low + 1 }
        : { ...box, y: low, height: high - low + 1 };
}

/**
 * Fit every line to the paint it came from on both axes: reach out to ink the
 * box missed, pull in over margin that holds none, and never touch the box
 * beside it. The boxes are measured once, as found, so the pass is order
 * independent and no two boxes end up touching.
 */
export function fitAcross<T extends Box>(
    boxes: T[],
    page: PageRect,
    det: TextMask | null,
    strokes: TextMask | null = null,
    regions: PageRect[] = [],
    obstacles: PageRect[] = [],
): T[] {
    if (!det && !strokes) return boxes;
    const frozen = boxes.map((box): PageRect => ({
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
    }));
    const plane = (det ?? strokes) as TextMask;
    return boxes.map((box, index) => {
        const wide = fitAxis(box, index, frozen, page, plane, strokes, regions, obstacles, true);
        return fitAxis(wide, index, frozen, page, plane, strokes, regions, obstacles, false);
    });
}

/**
 * The detector sometimes stops a glyph or two early, so the end of a column sits
 * outside its own box. The seg mask marks the strokes, so the box walks out to
 * the last stroke it can reach.
 */
export function expandToInk(
    box: Box,
    mask: TextMask | null,
    regions: PageRect[] = [],
    obstacles: PageRect[] = [],
): Box {
    if (!mask) return box;
    // A leaned hull is already the glyph rectangle. Growing the page box would
    // slide its centre and the rotation would miss the text.
    if (Math.abs(box.angle ?? 0) >= 0.01) return box;

    const vertical = box.height >= box.width;
    const start = grow(box, mask, 'start', vertical, regions, obstacles);
    const end = grow(box, mask, 'end', vertical, regions, obstacles);
    if (start === 0 && end === 0) return box;

    if (vertical) {
        return { ...box, y: box.y - start, height: box.height + start + end };
    }
    return { ...box, x: box.x - start, width: box.width + start + end };
}
