import { DETECTOR_INPUT_SIZE } from '../../shared/constants';
import { minAreaRect } from '../rect';
import type { Box, Prepared } from '../types';

/**
 * Line extraction.
 *
 * The detector answers two questions. The det head says where a line of text
 * sits, as a shrunken band per line; the seg head says which pixels are strokes.
 * This module turns the first into line seeds and the second into the ink each
 * seed has to cover, so a seed that the det head cut short still becomes a box
 * around the whole column.
 *
 * The seed path follows the detector's own postprocessing (connected components
 * of the det mask, a minimum area rectangle per component, and the DBNet unclip
 * that undoes the shrink). The stroke path is what repairs the seed: the model
 * marks some columns only in part, and some stylised lettering not at all.
 */

type Rect = { x0: number; y0: number; x1: number; y1: number };
type Stroke = Rect & { width: number; height: number; cx: number; cy: number };
type Component = { pixels: number[]; count: number; sum: number; rect: Rect };

export type PageRect = { x: number; y: number; width: number; height: number };

export type ExtractInput = {
    det: Float32Array;
    seg: Float32Array | null;
    prepared: Prepared;
    bubbles: PageRect[];
};

/** det above this is a line band. */
const LINE = 0.3;
/** A component is a line only when its own det response is strong. */
const LINE_SCORE = 0.6;
/** DBNet shrinks the band it predicts, so every seed is widened again. */
const UNCLIP = 1.5;
/** seg above this is a stroke. */
const STROKE = 0.46;
/** Fewest det pixels a line band can have. */
const MIN_LINE_PIXELS = 20;
/** Fewest seg pixels a stroke can have. */
const MIN_STROKE_PIXELS = 12;
/** A component thinner than this is noise, not a glyph. */
const MIN_SIDE = 3;
/** A line this close to a page axis is stored on the axis. */
const UPRIGHT = (20 * Math.PI) / 180;
/** Gaps between strokes are allowed up to this share of the line thickness. */
const ALONG_GAP = 1.1;
/** How much two strokes must share across the line to belong to it. */
const ACROSS_OVERLAP = 0.35;
/** Two strokes this different in size are not the same line. */
const SIZE_RATIO = 2.5;
/** A strip this empty in the det profile separates two columns. */
const CUT_EMPTY_SHARE = 0.15;
/** Shortest empty run that counts as a break, in page pixels. */
const CUT_MIN_RUN = 3;
/** A piece narrower than this share of the box cannot hold a column. */
const CUT_MIN_PIECE = 0.3;

function oddMedian(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
}

function insidePrepared(prepared: Prepared, x: number, y: number): boolean {
    return x >= prepared.padX
        && y >= prepared.padY
        && x < prepared.padX + Math.round(prepared.width * prepared.scale)
        && y < prepared.padY + Math.round(prepared.height * prepared.scale);
}

/** Eight connected components of one plane, over the page area only. */
function components(map: Float32Array, threshold: number, prepared: Prepared): Component[] {
    const size = DETECTOR_INPUT_SIZE;
    const visited = new Uint8Array(size * size);
    const pixels: number[] = [];
    const stack: number[] = [];
    const out: Component[] = [];

    for (let start = 0; start < size * size; start += 1) {
        if (map[start] < threshold || visited[start]) continue;
        // A response in the letterbox padding is not page content. The padding
        // is black, but a model channel is not required to agree.
        if (!insidePrepared(prepared, start % size, Math.floor(start / size))) continue;
        stack.push(start);
        visited[start] = 1;
        pixels.length = 0;
        let count = 0;
        let sum = 0;
        let minX = size;
        let minY = size;
        let maxX = -1;
        let maxY = -1;

        while (stack.length > 0) {
            const index = stack.pop() as number;
            const x = index % size;
            const y = (index - x) / size;
            count += 1;
            sum += map[index];
            pixels.push(index);
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;

            for (let dy = -1; dy <= 1; dy += 1) {
                for (let dx = -1; dx <= 1; dx += 1) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx;
                    const ny = y + dy;
                    if (!insidePrepared(prepared, nx, ny)) continue;
                    const next = ny * size + nx;
                    if (visited[next] || map[next] < threshold) continue;
                    visited[next] = 1;
                    stack.push(next);
                }
            }
        }

        out.push({
            pixels: [...pixels],
            count,
            sum,
            rect: { x0: minX, y0: minY, x1: maxX, y1: maxY },
        });
    }
    return out;
}

/** The pixels of one component that touch the plane outside it. */
function boundaryPoints(component: Component, map: Float32Array): { x: number; y: number }[] {
    const size = DETECTOR_INPUT_SIZE;
    const inside = new Set(component.pixels);
    const points: { x: number; y: number }[] = [];

    for (const index of component.pixels) {
        const x = index % size;
        const y = (index - x) / size;
        let edge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
        for (let dy = -1; dy <= 1 && !edge; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
                if (dx === 0 && dy === 0) continue;
                const next = (y + dy) * size + (x + dx);
                if (map[next] < LINE || !inside.has(next)) {
                    edge = true;
                    break;
                }
            }
        }
        if (edge) points.push({ x, y });
    }
    return points;
}

function mapToPage(prepared: Prepared, value: number, axis: 'x' | 'y'): number {
    const pad = axis === 'x' ? prepared.padX : prepared.padY;
    return (value - pad) / prepared.scale;
}

function clampRect(rect: Rect, width: number, height: number): Rect {
    return {
        x0: Math.max(0, rect.x0),
        y0: Math.max(0, rect.y0),
        x1: Math.min(width, rect.x1),
        y1: Math.min(height, rect.y1),
    };
}

function padRect(rect: Rect, pad: number, width: number, height: number): Rect {
    return clampRect({
        x0: rect.x0 - pad,
        y0: rect.y0 - pad,
        x1: rect.x1 + pad,
        y1: rect.y1 + pad,
    }, width, height);
}

function unionRect(rects: Rect[]): Rect | null {
    if (rects.length === 0) return null;
    let rect = { ...rects[0] };
    for (let index = 1; index < rects.length; index += 1) {
        const other = rects[index];
        rect = {
            x0: Math.min(rect.x0, other.x0),
            y0: Math.min(rect.y0, other.y0),
            x1: Math.max(rect.x1, other.x1),
            y1: Math.max(rect.y1, other.y1),
        };
    }
    return rect;
}

function centreInside(rect: Rect, x: number, y: number, margin: number): boolean {
    return x >= rect.x0 - margin && x <= rect.x1 + margin
        && y >= rect.y0 - margin && y <= rect.y1 + margin;
}

/**
 * A rectangle has no direction, so the angle folds into (-pi/4, pi/4]. A line
 * within twenty degrees of a page axis is stored on the axis: an upright column
 * with italic lettering is still an upright column, and a tilted page box would
 * spill into the column beside it.
 */
function foldedAngle(angle: number): number {
    let folded = ((angle % Math.PI) + Math.PI) % Math.PI;
    if (folded > Math.PI / 2) folded -= Math.PI;
    if (folded > Math.PI / 4) folded -= Math.PI / 2;
    if (folded <= -Math.PI / 4) folded += Math.PI / 2;
    return Math.abs(folded) < UPRIGHT ? 0 : folded;
}

function cornersOf(centre: { x: number; y: number }, length: number, thickness: number, angle: number): { x: number; y: number }[] {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const halfLength = length / 2;
    const halfThickness = thickness / 2;
    return [
        [-halfLength, -halfThickness],
        [halfLength, -halfThickness],
        [halfLength, halfThickness],
        [-halfLength, halfThickness],
    ].map(([along, across]) => ({
        x: centre.x + along * cos - across * sin,
        y: centre.y + along * sin + across * cos,
    }));
}

function axisAlignedRect(points: { x: number; y: number }[]): Rect {
    let rect: Rect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const point of points) {
        rect = {
            x0: Math.min(rect.x0, point.x),
            y0: Math.min(rect.y0, point.y),
            x1: Math.max(rect.x1, point.x),
            y1: Math.max(rect.y1, point.y),
        };
    }
    return rect;
}

/** The page box the rest of the pipeline expects, from one detector rectangle. */
function boxFromQuad(
    centre: { x: number; y: number },
    length: number,
    thickness: number,
    angle: number,
    score: number,
    width: number,
    height: number,
): Box | null {
    const corners = cornersOf(centre, length, thickness, angle);
    const rect = clampRect(axisAlignedRect(corners), width, height);
    const boxWidth = rect.x1 - rect.x0;
    const boxHeight = rect.y1 - rect.y0;
    if (boxWidth < 4 || boxHeight < 4) return null;

    const stored = foldedAngle(angle);
    if (stored === 0) {
        return { x: rect.x0, y: rect.y0, width: boxWidth, height: boxHeight, score };
    }
    return {
        x: rect.x0,
        y: rect.y0,
        width: boxWidth,
        height: boxHeight,
        score,
        angle: stored,
        lineLength: length,
        lineThickness: thickness,
    };
}

/** det bands widened by the DBNet unclip, in page pixels. */
function lineSeeds(det: Float32Array, prepared: Prepared): Box[] {
    const found: Box[] = [];
    for (const component of components(det, LINE, prepared)) {
        if (component.count < MIN_LINE_PIXELS) continue;
        const score = component.sum / component.count;
        if (score < LINE_SCORE) continue;

        // The rectangle follows the band's own slant, which is what a leaned
        // sound effect needs. An upright line lands on the page axis below.
        const rect = minAreaRect(boundaryPoints(component, det));
        if (!rect) continue;
        const short = Math.min(rect.length, rect.thickness);
        if (short < 2) continue;

        const area = rect.length * rect.thickness;
        const perimeter = 2 * (rect.length + rect.thickness);
        const grow = (area * UNCLIP) / perimeter;
        const length = rect.length + grow * 2;
        const thickness = rect.thickness + grow * 2;

        const box = boxFromQuad(
            { x: mapToPage(prepared, rect.centre.x, 'x'), y: mapToPage(prepared, rect.centre.y, 'y') },
            length / prepared.scale,
            thickness / prepared.scale,
            rect.angle,
            score,
            prepared.width,
            prepared.height,
        );
        if (box) found.push(box);
    }
    return found;
}

/**
 * A box can hold two columns in two ways. The det head can return one band for
 * both, or one stroke can span them when the page is noisy. The det map still
 * has an empty strip between the two bands, so the box is cut there. The cut
 * only changes the thin side; the length stays, which costs a crop a little
 * empty paper but never a glyph.
 */
type SplitOptions = {
    /** Peak response below which the box is not worth cutting. */
    minPeak: number;
    /** A run this empty, as a share of the peak, is a break. */
    emptyShare: number;
    /** Shortest empty run that counts, in page pixels. */
    minRun: number;
};

function splitAcrossPlaneGaps(
    box: Box,
    plane: TextPlane,
    width: number,
    height: number,
    options: SplitOptions,
): Box[] {
    if (box.angle !== undefined && box.angle !== 0) return [box];
    const vertical = box.height >= box.width;
    const crossStart = vertical ? box.x : box.y;
    const crossSpan = Math.round(vertical ? box.width : box.height);
    const alongStart = vertical ? box.y : box.x;
    const alongSpan = vertical ? box.height : box.width;
    if (crossSpan < 24 || alongSpan < 24) return [box];

    // The profile takes the strongest response down each line of the thin axis,
    // so a gap that runs the whole length of the box is the only kind it sees.
    const steps = Math.min(24, Math.max(8, Math.round(alongSpan / 8)));
    const profile = new Float32Array(crossSpan);
    let peak = 0;
    for (let index = 0; index < crossSpan; index += 1) {
        const across = crossStart + index + 0.5;
        let best = 0;
        for (let step = 0; step < steps; step += 1) {
            const along = alongStart + (alongSpan * (step + 0.5)) / steps;
            const value = vertical ? planeAt(plane, across, along) : planeAt(plane, along, across);
            if (value > best) best = value;
        }
        profile[index] = best;
        if (best > peak) peak = best;
    }
    if (peak < options.minPeak) return [box];

    const floor = peak * options.emptyShare;
    const cuts: number[] = [];
    let run = -1;
    for (let index = 0; index <= crossSpan; index += 1) {
        const blank = index < crossSpan && profile[index] <= floor;
        if (blank) {
            if (run < 0) run = index;
            continue;
        }
        if (run >= 0) {
            // A margin at either end belongs to the line beside it, not to a gap
            // inside this one. Cutting there would trade one box for two strips.
            if (run > 0 && index < crossSpan && index - run >= options.minRun) {
                cuts.push(Math.round((run + index - 1) / 2));
            }
            run = -1;
        }
    }
    if (cuts.length === 0) return [box];

    const bounds = [0, ...cuts, crossSpan];
    const pieces: Box[] = [];
    for (let index = 1; index < bounds.length; index += 1) {
        const from = bounds[index - 1];
        const to = bounds[index];
        if (to - from < Math.max(8, crossSpan * CUT_MIN_PIECE)) return [box];
        // Pad the outside of the box only. Padding a cut would make the two
        // pieces overlap, and an overlap is what the reading order pass merges.
        const padStart = from === 0 ? 1 : 0;
        const padEnd = to === crossSpan ? 1 : 0;
        const start = crossStart + from - padStart;
        const size = to - from + padStart + padEnd;
        pieces.push(vertical
            ? {
                ...box,
                x: Math.max(0, start),
                width: Math.min(width, start + size) - Math.max(0, start),
            }
            : {
                ...box,
                y: Math.max(0, start),
                height: Math.min(height, start + size) - Math.max(0, start),
            });
    }
    return pieces.length >= 2 ? pieces : [box];
}

function splitAcrossDetGaps(box: Box, plane: TextPlane, width: number, height: number): Box[] {
    return splitAcrossPlaneGaps(box, plane, width, height, {
        minPeak: LINE,
        emptyShare: CUT_EMPTY_SHARE,
        minRun: CUT_MIN_RUN,
    });
}

/**
 * Cut a box that holds two text lines with no det gap between them. The det head
 * can return one band for two rows of a caption or two columns of a balloon, and
 * the profile it produces has no valley. The stroke plane does: glyphs stop at
 * the space between the lines. Each piece keeps the length of the whole box.
 */
function splitAcrossStrokeGaps(box: Box, plane: TextPlane, width: number, height: number): Box[] {
    return splitAcrossPlaneGaps(box, plane, width, height, {
        minPeak: STROKE / 2,
        emptyShare: 0.25,
        minRun: 2,
    });
}

/** Every glyph stroke, in page pixels. */
function strokeParts(seg: Float32Array, prepared: Prepared): Stroke[] {
    const maxSide = Math.max(24, Math.min(prepared.width, prepared.height) * 0.45);
    const parts: Stroke[] = [];
    for (const component of components(seg, STROKE, prepared)) {
        if (component.count < MIN_STROKE_PIXELS) continue;
        const rect = component.rect;
        const x0 = mapToPage(prepared, rect.x0, 'x');
        const y0 = mapToPage(prepared, rect.y0, 'y');
        const width = (rect.x1 - rect.x0 + 1) / prepared.scale;
        const height = (rect.y1 - rect.y0 + 1) / prepared.scale;
        if (Math.min(width, height) < MIN_SIDE) continue;
        if (Math.max(width, height) > maxSide) continue;
        parts.push({
            x0,
            y0,
            x1: x0 + width,
            y1: y0 + height,
            width,
            height,
            cx: x0 + width / 2,
            cy: y0 + height / 2,
        });
    }
    return parts;
}

function overlapsAcross(a: Rect, b: Rect, vertical: boolean): number {
    return vertical
        ? Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
        : Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
}

function gapAlong(a: Rect, b: Rect, vertical: boolean): number {
    return vertical
        ? Math.max(0, Math.max(b.y0 - a.y1, a.y0 - b.y1))
        : Math.max(0, Math.max(b.x0 - a.x1, a.x0 - b.x1));
}

function widthOf(rect: Rect): number {
    return rect.x1 - rect.x0;
}

function heightOf(rect: Rect): number {
    return rect.y1 - rect.y0;
}

/**
 * Follow the strokes of one seed's line. A column is a stack of glyphs that
 * share the same band across the line, so a stroke joins when it overlaps that
 * band and sits within about one em along it. A stroke from the column beside
 * it overlaps nothing, which is what keeps two lines apart.
 */
function extendToStrokes(start: Rect, strokes: Stroke[], claimed: Uint8Array): { rect: Rect; members: number[] } {
    const vertical = heightOf(start) >= widthOf(start);
    let rect = { ...start };
    const members: number[] = [];

    while (true) {
        const thickness = vertical ? widthOf(rect) : heightOf(rect);
        const alongLimit = Math.max(8, thickness * ALONG_GAP);
        let best = -1;
        let bestGap = Infinity;

        for (let index = 0; index < strokes.length; index += 1) {
            if (claimed[index]) continue;
            const stroke = strokes[index];
            const across = overlapsAcross(rect, stroke, vertical);
            if (across < Math.min(thickness, vertical ? stroke.width : stroke.height) * ACROSS_OVERLAP) continue;
            const cross = vertical ? stroke.width : stroke.height;
            if (cross > thickness * 2.2 || cross < thickness * 0.2) continue;
            const gap = gapAlong(rect, stroke, vertical);
            if (gap > alongLimit) continue;
            if (gap < bestGap) {
                bestGap = gap;
                best = index;
            }
        }

        if (best < 0) break;
        claimed[best] = 1;
        members.push(best);
        const stroke = strokes[best];
        rect = {
            x0: Math.min(rect.x0, stroke.x0),
            y0: Math.min(rect.y0, stroke.y0),
            x1: Math.max(rect.x1, stroke.x1),
            y1: Math.max(rect.y1, stroke.y1),
        };
    }

    return { rect, members };
}

/**
 * Strokes the det head never covered. They are grouped into lines by the same
 * rule that grows a seed, then a group is kept only when it looks like text: two
 * or more glyphs on one band, close enough in size, and either a det response
 * or a place inside a balloon. That last test recovers stylised lettering the
 * det head skips, without turning the artwork in a dark panel into dialogue.
 */
function groupLeftoverStrokes(strokes: Stroke[], claimed: Uint8Array): number[][] {
    const parent = strokes.map((_, index) => index);
    const find = (index: number): number => {
        let root = index;
        while (parent[root] !== root) root = parent[root];
        let cursor = index;
        while (parent[cursor] !== cursor) {
            const next = parent[cursor];
            parent[cursor] = root;
            cursor = next;
        }
        return root;
    };
    const union = (left: number, right: number): void => {
        const a = find(left);
        const b = find(right);
        if (a !== b) parent[b] = a;
    };
    const similar = (a: Stroke, b: Stroke): boolean => {
        const small = Math.min(a.width, a.height, b.width, b.height);
        const large = Math.max(a.width, a.height, b.width, b.height);
        return small > 0 && large / small <= SIZE_RATIO * 1.6;
    };

    // A column first: two glyphs of one column share their band across it.
    for (let left = 0; left < strokes.length; left += 1) {
        if (claimed[left]) continue;
        for (let right = left + 1; right < strokes.length; right += 1) {
            if (claimed[right]) continue;
            const a = strokes[left];
            const b = strokes[right];
            if (!similar(a, b)) continue;
            const across = overlapsAcross(a, b, true);
            const gap = gapAlong(a, b, true);
            const limit = Math.max(6, Math.min(a.width, b.width) * 0.9);
            if (across >= Math.min(a.width, b.width) * 0.5 && gap <= limit) union(left, right);
        }
    }

    // Then a row, but only between glyphs that are not already part of a
    // column: two vertical columns also sit side by side, and joining them would
    // read both speeches as one horizontal line.
    const groups = new Map<number, number[]>();
    for (let index = 0; index < strokes.length; index += 1) {
        if (claimed[index]) continue;
        const root = find(index);
        const bucket = groups.get(root);
        if (bucket) bucket.push(index);
        else groups.set(root, [index]);
    }
    const singles = [...groups.values()].filter((group) => group.length === 1).map((group) => group[0]);
    for (let left = 0; left < singles.length; left += 1) {
        const a = strokes[singles[left]];
        for (let right = left + 1; right < singles.length; right += 1) {
            const b = strokes[singles[right]];
            if (!similar(a, b)) continue;
            const across = overlapsAcross(a, b, false);
            const gap = gapAlong(a, b, false);
            const limit = Math.max(6, Math.min(a.height, b.height) * 0.9);
            if (across >= Math.min(a.height, b.height) * 0.5 && gap <= limit) {
                union(singles[left], singles[right]);
            }
        }
    }

    const merged = new Map<number, number[]>();
    for (let index = 0; index < strokes.length; index += 1) {
        if (claimed[index]) continue;
        const root = find(index);
        const bucket = merged.get(root);
        if (bucket) bucket.push(index);
        else merged.set(root, [index]);
    }
    return [...merged.values()];
}

function overlapRatio(a: Box, b: Box): number {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    if (right <= left || bottom <= top) return 0;
    const shared = (right - left) * (bottom - top);
    return shared / Math.min(a.width * a.height, b.width * b.height);
}

/** Mean response of one plane over a sparse grid inside a page rectangle. */
function samplePlane(plane: TextPlane, rect: Box, samples = 16): number {
    let sum = 0;
    let count = 0;
    for (let row = 0; row < samples; row += 1) {
        const y = rect.y + (rect.height * (row + 0.5)) / samples;
        for (let column = 0; column < samples; column += 1) {
            const x = rect.x + (rect.width * (column + 0.5)) / samples;
            sum += planeAt(plane, x, y);
            count += 1;
        }
    }
    return count > 0 ? sum / count : 0;
}

export type TextPlane = { data: Float32Array; scale: number; padX: number; padY: number };

function planeAt(plane: TextPlane, pageX: number, pageY: number): number {
    const x = Math.round(pageX * plane.scale + plane.padX);
    const y = Math.round(pageY * plane.scale + plane.padY);
    if (x < 0 || y < 0 || x >= DETECTOR_INPUT_SIZE || y >= DETECTOR_INPUT_SIZE) return 0;
    return plane.data[y * DETECTOR_INPUT_SIZE + x];
}

/**
 * Turn one detector pass into line boxes.
 *
 * Seeds come from the det head, strokes from the seg head. Each seed grows to
 * the strokes of its own column, and strokes no seed reached are grouped into
 * lines of their own.
 */
export function extractLineBoxes(input: ExtractInput): Box[] {
    const { det, seg, prepared, bubbles } = input;
    const width = prepared.width;
    const height = prepared.height;
    const pageArea = width * height;
    const detPlane: TextPlane = { data: det, scale: prepared.scale, padX: prepared.padX, padY: prepared.padY };
    const segPlane: TextPlane | null = seg
        ? { data: seg, scale: prepared.scale, padX: prepared.padX, padY: prepared.padY }
        : null;

    const seeds = lineSeeds(det, prepared).sort(
        (a, b) => b.width * b.height - a.width * a.height,
    );
    const strokes = seg ? strokeParts(seg, prepared) : [];
    const claimed = new Uint8Array(strokes.length);
    const boxes: Box[] = [];

    for (const seed of seeds) {
        const seedRect: Rect = {
            x0: seed.x,
            y0: seed.y,
            x1: seed.x + seed.width,
            y1: seed.y + seed.height,
        };

        // The members this seed already holds, so the growth walk starts from
        // the line it was found on rather than from its shrunken band.
        const members: number[] = [];
        for (let index = 0; index < strokes.length; index += 1) {
            if (claimed[index]) continue;
            if (!centreInside(seedRect, strokes[index].cx, strokes[index].cy, 2)) continue;
            members.push(index);
        }

        if (seed.angle !== undefined && seed.angle !== 0) {
            // A leaned line is already the glyph rectangle; growing its page box
            // would flatten the slant.
            for (const index of members) claimed[index] = 1;
            boxes.push(seed);
            continue;
        }

        const start = unionRect([
            seedRect,
            ...members.map((index) => strokes[index]),
        ]) as Rect;
        for (const index of members) claimed[index] = 1;

        const grown = extendToStrokes(start, strokes, claimed);
        const finalRect = padRect(grown.rect, 1, width, height);
        const boxWidth = finalRect.x1 - finalRect.x0;
        const boxHeight = finalRect.y1 - finalRect.y0;
        if (boxWidth < 4 || boxHeight < 4) continue;
        const line: Box = {
            x: finalRect.x0,
            y: finalRect.y0,
            width: boxWidth,
            height: boxHeight,
            score: seed.score,
        };
        boxes.push(...splitAcrossDetGaps(line, detPlane, width, height));
    }

    if (seg) {
        const thicknesses = boxes
            .map((box) => Math.min(box.width, box.height))
            .filter((size) => size >= 4)
            .sort((left, right) => left - right);
        const median = oddMedian(thicknesses);
        for (const group of groupLeftoverStrokes(strokes, claimed)) {
            const rect = unionRect(group.map((index) => strokes[index]));
            if (!rect) continue;
            const padded = padRect(rect, 1, width, height);
            const box: Box = {
                x: padded.x0,
                y: padded.y0,
                width: padded.x1 - padded.x0,
                height: padded.y1 - padded.y0,
                score: 0.6,
            };
            if (box.width < 5 || box.height < 5) continue;
            if (box.width * box.height > pageArea * 0.25) continue;
            // One stroke on its own is a line of a piece of artwork, a panel
            // border, or a highlight. Lettering is at least two glyphs.
            if (group.length < 2) continue;
            const long = Math.max(box.width, box.height);
            const short = Math.max(1, Math.min(box.width, box.height));
            // A glyph size far from the page's own is a texture, not lettering.
            if (median > 0 && (short > median * 4 || short < median * 0.35)) continue;
            if (boxes.some((other) => overlapRatio(box, other) > 0.35)) continue;

            const insideBalloon = bubbles.some((bubble) =>
                box.x + box.width / 2 >= bubble.x - 8
                && box.x + box.width / 2 <= bubble.x + bubble.width + 8
                && box.y + box.height / 2 >= bubble.y - 8
                && box.y + box.height / 2 <= bubble.y + bubble.height + 8,
            );
            // A speech inside a balloon can be square, because two columns of
            // two glyphs fill a ball. Loose lettering outside a balloon runs in
            // one direction, so a square cluster there is a piece of a drawing:
            // two strokes of one large sound effect glyph must not become a line.
            if (!insideBalloon && long < short * 1.8) continue;
            const detMean = samplePlane(detPlane, box);
            if (!insideBalloon && detMean < 0.12) continue;
            boxes.push({ ...box, score: insideBalloon ? 0.55 : 0.6 });
        }
    }

    // A box can hold two rows or two columns that the det head never separated.
    // Split it on the stroke plane before anything downstream reads it as one
    // line, so OCR and the translation each see a column of their own.
    const separated = segPlane
        ? boxes.flatMap((box) => splitAcrossStrokeGaps(box, segPlane, width, height))
        : boxes;

    // One glyph run can be found twice: once as a seed and once as leftover
    // strokes. Keep the larger box, which is the one that saw the whole line.
    const ranked = [...separated].sort((a, b) => b.width * b.height - a.width * a.height);
    const kept: Box[] = [];
    for (const box of ranked) {
        if (kept.some((other) => overlapRatio(box, other) > 0.5)) continue;
        const paint = samplePlane(detPlane, box) + (segPlane ? samplePlane(segPlane, box) : 0);
        if (paint < 0.02) continue;
        kept.push(box);
    }

    return kept.sort((a, b) => (Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x));
}
