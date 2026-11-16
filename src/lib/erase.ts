import { INPAINT_INPUT_SIZE } from '../shared/constants';
import { inpaintTile, scaleImage } from './inpaint';
import type { Box, TextMask } from './types';
import { pagePointAt, uprightFrame } from './warp';

const GLYPH_THRESHOLD = 0.3;
const BACKGROUND_THRESHOLD = 0.1;
const MODEL_SIZE = 1024;

/** Read the seg value that belongs to one pixel of the upright crop. */
function maskAt(mask: TextMask, box: Box, x: number, y: number): number {
    const frame = uprightFrame(box);
    const page = pagePointAt(frame, x + 0.5, y + 0.5);
    const pageX = page.x;
    const pageY = page.y;
    const sourceX = Math.round(pageX * mask.scale + mask.padX);
    const sourceY = Math.round(pageY * mask.scale + mask.padY);
    if (sourceX < 0 || sourceY < 0 || sourceX >= MODEL_SIZE || sourceY >= MODEL_SIZE) return 0;
    return mask.data[sourceY * MODEL_SIZE + sourceX];
}

/**
 * The bubble behind a line is mostly paper, so the median of the pixels the seg
 * map calls background gives its colour without reading the glyph edges.
 */
function backgroundColour(pixels: Uint8ClampedArray, values: Float32Array): [number, number, number] {
    const reds: number[] = [];
    const greens: number[] = [];
    const blues: number[] = [];

    for (let index = 0; index < values.length; index += 1) {
        if (values[index] > BACKGROUND_THRESHOLD) continue;
        const offset = index * 4;
        reds.push(pixels[offset]);
        greens.push(pixels[offset + 1]);
        blues.push(pixels[offset + 2]);
    }

    const median = (channel: number[]): number => {
        if (channel.length === 0) return 255;
        channel.sort((a, b) => a - b);
        return channel[channel.length >> 1];
    };

    return [median(reds), median(greens), median(blues)];
}

/**
 * Paint over every glyph pixel of one crop with the colour of the bubble behind
 * it. A pixel counts as a glyph when its own seg value passes the threshold, and
 * the mask grows by one pixel to catch the soft edge of the stroke.
 */
export function eraseGlyphs(
    image: ImageData,
    box: Box,
    mask: TextMask,
    /** Return false to leave a page pixel untouched, which keeps a run inside its balloon. */
    allow?: (pageX: number, pageY: number) => boolean,
): void {
    const { width, height, data } = image;
    const values = new Float32Array(width * height);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            values[y * width + x] = maskAt(mask, box, x, y);
        }
    }

    const [red, green, blue] = backgroundColour(data, values);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            let glyph = false;
            for (let dy = -1; dy <= 1 && !glyph; dy += 1) {
                for (let dx = -1; dx <= 1; dx += 1) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                    if (values[ny * width + nx] > GLYPH_THRESHOLD) {
                        glyph = true;
                        break;
                    }
                }
            }
            if (!glyph) continue;

            if (allow) {
                const page = pagePointAt(uprightFrame(box), x + 0.5, y + 0.5);
                if (!allow(page.x, page.y)) continue;
            }

            const offset = (y * width + x) * 4;
            data[offset] = red;
            data[offset + 1] = green;
            data[offset + 2] = blue;
        }
    }
}


/** One page rectangle to erase. */
export type EraseBox = {
    x: number;
    y: number;
    width: number;
    height: number;
    angle?: number;
    /** Paper colour of the balloon the box sits in, when one was sampled. */
    paper?: [number, number, number];
    /**
     * 'line' is a box from the det head: it is drawn around text, so every
     * stroke the image shows near the det band inside it is text. 'region' is
     * any other box (a reader region, a ruby box): only the seg plane or the
     * det band says where its text is. 'block' is a BLK box: the text inside
     * it is the det plane, unclipped to the glyph extent (see maskOfBlock).
     */
    kind?: 'line' | 'region' | 'block';
    /** Rectangles inside a block whose ink stays, such as a sound effect. */
    keep?: { x: number; y: number; width: number; height: number }[];
};

/** The planes the detector produced, in its letterboxed 1024 square. */
export type ErasePlanes = { seg: TextMask | null; det: TextMask | null };

/** Fills an INPAINT_INPUT_SIZE tile; injected so a test can stub the model. */
export type TileInpainter = (image: ImageData, hole: Uint8Array) => Promise<ImageData>;

const SEG_INK = 0.25;
const SEG_NEAR = 0.15;
const DET_NEAR = 0.15;
/** A ring pixel this close to the ring's median luminance counts as paper. */
const FLAT_SPREAD = 26;
/** Share of the ring that must be paper for the box to be filled flat. */
const FLAT_SHARE = 0.88;
/** Luminance step from the paper that marks a stroke pixel. */
const INK_STEP = 18;
/** Luminance step of the dark core of a stroke or a ruled line. */
const RULE_STEP = 60;

function planeAt(plane: TextMask | null, pageX: number, pageY: number): number {
    if (!plane) return 0;
    const x = Math.round(pageX * plane.scale + plane.padX);
    const y = Math.round(pageY * plane.scale + plane.padY);
    if (x < 0 || y < 0 || x >= MODEL_SIZE || y >= MODEL_SIZE) return 0;
    return plane.data[y * MODEL_SIZE + x];
}

function luma(data: Uint8ClampedArray, offset: number): number {
    return data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
}

type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Whether a page point is inside the box, rotated about its centre when it leans. */
function hitTest(box: EraseBox): (x: number, y: number) => boolean {
    const angle = box.angle ?? 0;
    if (Math.abs(angle) < 0.01) {
        return (x, y) => x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
    }
    const centreX = box.x + box.width / 2;
    const centreY = box.y + box.height / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return (x, y) => {
        const dx = x - centreX;
        const dy = y - centreY;
        return Math.abs(dx * cos + dy * sin) <= box.width / 2 && Math.abs(-dx * sin + dy * cos) <= box.height / 2;
    };
}

function boundsOf(box: EraseBox, grow: number, width: number, height: number): Rect {
    const angle = box.angle ?? 0;
    let x0 = box.x;
    let y0 = box.y;
    let x1 = box.x + box.width;
    let y1 = box.y + box.height;
    if (Math.abs(angle) >= 0.01) {
        const centreX = box.x + box.width / 2;
        const centreY = box.y + box.height / 2;
        const halfX = (Math.abs(Math.cos(angle)) * box.width + Math.abs(Math.sin(angle)) * box.height) / 2;
        const halfY = (Math.abs(Math.sin(angle)) * box.width + Math.abs(Math.cos(angle)) * box.height) / 2;
        x0 = centreX - halfX;
        x1 = centreX + halfX;
        y0 = centreY - halfY;
        y1 = centreY + halfY;
    }
    return {
        x0: Math.max(0, Math.floor(x0 - grow)),
        y0: Math.max(0, Math.floor(y0 - grow)),
        x1: Math.min(width, Math.ceil(x1 + grow)),
        y1: Math.min(height, Math.ceil(y1 + grow)),
    };
}

/** Square-ish grow of a local mask by `radius` pixels (a disc). */
/** The same, but with a different reach on each axis. */
function growRect(
    mask: Uint8Array,
    width: number,
    height: number,
    across: number,
    along: number,
): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (mask[y * width + x] !== 1) continue;
            const top = Math.max(0, y - along);
            const bottom = Math.min(height - 1, y + along);
            const from = Math.max(0, x - across);
            const to = Math.min(width - 1, x + across);
            for (let ny = top; ny <= bottom; ny += 1) out.fill(1, ny * width + from, ny * width + to + 1);
        }
    }
    return out;
}

function grow(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array<ArrayBuffer> {
    if (radius <= 0) return new Uint8Array(mask);
    const out = new Uint8Array(mask.length);
    const limit = radius * radius + 0.25;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (mask[y * width + x] !== 1) continue;
            for (let dy = -radius; dy <= radius; dy += 1) {
                const ny = y + dy;
                if (ny < 0 || ny >= height) continue;
                const half = Math.floor(Math.sqrt(limit - dy * dy));
                const from = Math.max(0, x - half);
                const to = Math.min(width - 1, x + half);
                out.fill(1, ny * width + from, ny * width + to + 1);
            }
        }
    }
    return out;
}

type BoxMask = {
    area: Rect;
    /** Strokes on flat paper, filled with `colour`. */
    flatMask: Uint8Array;
    /** Pixels the model fills. */
    modelMask: Uint8Array;
    colour: [number, number, number] | null;
};

/**
 * The paper the text is printed on, read inside the box from the pixels the
 * seg plane leaves out. A caption box sitting on artwork is still white inside,
 * so the ring outside the box cannot decide this. Flat when nearly all of them
 * sit near the median tone.
 */
function paperInside(
    page: ImageData,
    planes: ErasePlanes,
    area: Rect,
    hits: (x: number, y: number) => boolean,
): { colour: [number, number, number]; luma: number; flat: boolean } | null {
    const lumas: number[] = [];
    const reds: number[] = [];
    const greens: number[] = [];
    const blues: number[] = [];
    for (let y = area.y0; y < area.y1; y += 1) {
        for (let x = area.x0; x < area.x1; x += 1) {
            if (!hits(x + 0.5, y + 0.5)) continue;
            if (planeAt(planes.seg, x + 0.5, y + 0.5) >= 0.1) continue;
            const offset = (y * page.width + x) * 4;
            lumas.push(luma(page.data, offset));
            reds.push(page.data[offset]);
            greens.push(page.data[offset + 1]);
            blues.push(page.data[offset + 2]);
        }
    }
    if (lumas.length < 16) return null;
    const median = (values: number[]): number => values.slice().sort((left, right) => left - right)[values.length >> 1];
    const middle = median(lumas);
    const near = lumas.filter((value) => Math.abs(value - middle) <= FLAT_SPREAD).length;
    return {
        colour: [median(reds), median(greens), median(blues)],
        luma: middle,
        flat: near / lumas.length >= FLAT_SHARE,
    };
}

/**
 * Find the ruled lines in a stroke mask: a frame edge or a panel border that
 * crosses the box is a straight run of ink far longer than any stroke of a
 * glyph. A run counts when it covers most of the box along its axis and is
 * much longer than the box is thick across it, which a glyph stroke never is.
 * Runs are traced per row and per column, so a stroke or a strand of hair
 * touching the rule does not hide it.
 */
function findRules(mask: Uint8Array, width: number, height: number): Uint8Array {
    const rules = new Uint8Array(mask.length);
    const gap = 2;
    const scan = (count: number, length: number, at: (line: number, step: number) => number, need: number): void => {
        for (let line = 0; line < count; line += 1) {
            let start = -1;
            let last = -1;
            const close = (): void => {
                if (start >= 0 && last - start + 1 >= need) {
                    for (let step = start; step <= last; step += 1) rules[at(line, step)] = 1;
                }
                start = -1;
            };
            for (let step = 0; step < length; step += 1) {
                if (mask[at(line, step)] !== 1) {
                    if (start >= 0 && step - last > gap) close();
                    continue;
                }
                if (start < 0) start = step;
                last = step;
            }
            close();
        }
    };
    const rowNeed = Math.max(width * 0.45, height * 1.5);
    if (rowNeed <= width) scan(height, width, (row, column) => row * width + column, rowNeed);
    const columnNeed = Math.max(height * 0.45, width * 1.5);
    if (columnNeed <= height) scan(width, height, (column, row) => row * width + column, columnNeed);
    return rules;
}

/**
 * The pixels of one box to erase, in a local window around it.
 *
 * On flat paper (read inside the box): the strokes are whatever stands a clear
 * step off the paper tone near the det band or the seg strokes, which takes the
 * anti-aliased rim of a glyph with it. Ruled lines are removed from that set,
 * and the strokes are filled with the paper.
 *
 * Elsewhere the model fills the hole, so the hole follows the seg strokes,
 * grown by a fraction of the text size to take their outline and rim: tight
 * enough that the model keeps most of the art, at page resolution so no stroke
 * falls out of it.
 *
 * Nothing outside the box (plus a few pixels for the stroke rim) is touched,
 * which is what keeps a panel border or a caption frame next to the text.
 */
function maskOfBox(page: ImageData, planes: ErasePlanes, box: EraseBox): BoxMask | null {
    const thickness = Math.max(4, Math.min(box.width, box.height));
    const rim = Math.max(2, Math.round(thickness * 0.06));
    const area = boundsOf(box, rim, page.width, page.height);
    const width = area.x1 - area.x0;
    const height = area.y1 - area.y0;
    if (width <= 0 || height <= 0) return null;
    const inBox = hitTest(box);
    const hits = hitTest({ ...box, x: box.x - rim, y: box.y - rim, width: box.width + rim * 2, height: box.height + rim * 2 });
    const paper = paperInside(page, planes, boundsOf(box, 0, page.width, page.height), inBox);
    const flat = paper?.flat ? paper : null;

    // seed: where the detector puts text (det band or seg stroke). segSeed:
    // the seg strokes alone, which is what a model hole follows.
    const seed = new Uint8Array(width * height);
    const segSeed = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const pageX = area.x0 + x + 0.5;
            const pageY = area.y0 + y + 0.5;
            if (!hits(pageX, pageY)) continue;
            const seg = planeAt(planes.seg, pageX, pageY);
            if (seg >= SEG_NEAR) segSeed[y * width + x] = 1;
            if (seg >= SEG_NEAR || planeAt(planes.det, pageX, pageY) >= DET_NEAR) seed[y * width + x] = 1;
        }
    }
    const segHole = grow(segSeed, width, height, Math.max(3, Math.round(thickness * 0.15)));

    const total = width * height;
    const flatMask = new Uint8Array(total);
    let modelMask = new Uint8Array(total);
    if (flat) {
        const zone = grow(seed, width, height, Math.max(2, Math.round(thickness * 0.12)));
        // Every pixel a clear step off the paper, over the whole box: ruled
        // lines are found on this, because inside the text zone alone a frame
        // edge breaks into short pieces that look like strokes.
        const ink = new Uint8Array(total);
        const strong = new Uint8Array(total);
        const paperish = new Uint8Array(total);
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const index = y * width + x;
                const pageX = area.x0 + x + 0.5;
                const pageY = area.y0 + y + 0.5;
                const offset = ((area.y0 + y) * page.width + area.x0 + x) * 4;
                const step = Math.abs(luma(page.data, offset) - flat.luma);
                if (step <= FLAT_SPREAD) paperish[index] = 1;
                if (!hits(pageX, pageY)) continue;
                if (step > INK_STEP || planeAt(planes.seg, pageX, pageY) >= SEG_INK) ink[index] = 1;
                if (step > RULE_STEP) strong[index] = 1;
            }
        }
        // Rules are traced on the dark core only: the faint rim pixels the
        // erase wants would bridge a frame edge to the glyphs beside it.
        const rules = grow(findRules(strong, width, height), width, height, 1);
        for (let index = 0; index < total; index += 1) if (rules[index] === 1) ink[index] = 0;
        let strokes = new Uint8Array(total);
        for (let index = 0; index < total; index += 1) if (ink[index] === 1 && zone[index] === 1) strokes[index] = 1;
        strokes = grow(strokes, width, height, Math.max(1, Math.round(thickness * 0.04)));
        // A box can straddle paper and screentone. A stroke is filled flat only
        // where the pixels around it, other than strokes, are mostly paper; the
        // rest goes to the model, which can continue the tone.
        const radius = Math.max(3, Math.round(thickness * 0.3));
        const sumPaper = new Uint32Array((width + 1) * (height + 1));
        const sumOpen = new Uint32Array((width + 1) * (height + 1));
        for (let y = 0; y < height; y += 1) {
            let rowPaper = 0;
            let rowOpen = 0;
            for (let x = 0; x < width; x += 1) {
                const index = y * width + x;
                if (strokes[index] !== 1) {
                    rowOpen += 1;
                    if (paperish[index] === 1) rowPaper += 1;
                }
                const at = (y + 1) * (width + 1) + x + 1;
                sumPaper[at] = sumPaper[at - width - 1] + rowPaper;
                sumOpen[at] = sumOpen[at - width - 1] + rowOpen;
            }
        }
        const windowSum = (sum: Uint32Array, x: number, y: number): number => {
            const left = Math.max(0, x - radius);
            const top = Math.max(0, y - radius);
            const right = Math.min(width, x + radius + 1);
            const bottom = Math.min(height, y + radius + 1);
            return sum[bottom * (width + 1) + right] - sum[top * (width + 1) + right]
                - sum[bottom * (width + 1) + left] + sum[top * (width + 1) + left];
        };
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const index = y * width + x;
                if (strokes[index] !== 1) continue;
                const open = windowSum(sumOpen, x, y);
                const share = open > 0 ? windowSum(sumPaper, x, y) / open : 1;
                if (share >= 0.8) flatMask[index] = 1;
                else modelMask[index] = 1;
            }
        }
        // Off the paper, the hole follows the seg strokes: the contrast test
        // there also takes every dot of the screentone, and a hole that size
        // comes back as a blank patch.
        modelMask = grow(modelMask, width, height, Math.max(3, Math.round(thickness * 0.15)));
        for (let index = 0; index < total; index += 1) if (segHole[index] !== 1) modelMask[index] = 0;
    } else {
        modelMask = segHole;
    }
    let any = 0;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = y * width + x;
            if (!hits(area.x0 + x + 0.5, area.y0 + y + 0.5)) {
                flatMask[index] = 0;
                modelMask[index] = 0;
                continue;
            }
            if (modelMask[index] === 1) flatMask[index] = 0;
            if (flatMask[index] === 1 || modelMask[index] === 1) any += 1;
        }
    }
    if (any === 0) return null;
    return { area, flatMask, modelMask, colour: flat ? flat.colour : null };
}

/** 4-connected components of a mask, as pixel index lists with their bounds. */
function components(mask: Uint8Array, width: number, height: number): { members: number[]; width: number; height: number }[] {
    const seen = new Uint8Array(mask.length);
    const out: { members: number[]; width: number; height: number }[] = [];
    const stack: number[] = [];
    for (let start = 0; start < mask.length; start += 1) {
        if (mask[start] !== 1 || seen[start]) continue;
        const members: number[] = [];
        let x0 = width;
        let y0 = height;
        let x1 = 0;
        let y1 = 0;
        seen[start] = 1;
        stack.push(start);
        while (stack.length > 0) {
            const index = stack.pop() as number;
            members.push(index);
            const x = index % width;
            const y = (index - x) / width;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
            if (x > 0 && mask[index - 1] === 1 && !seen[index - 1]) { seen[index - 1] = 1; stack.push(index - 1); }
            if (x < width - 1 && mask[index + 1] === 1 && !seen[index + 1]) { seen[index + 1] = 1; stack.push(index + 1); }
            if (y > 0 && mask[index - width] === 1 && !seen[index - width]) { seen[index - width] = 1; stack.push(index - width); }
            if (y < height - 1 && mask[index + width] === 1 && !seen[index + width]) { seen[index + width] = 1; stack.push(index + width); }
        }
        out.push({ members, width: x1 - x0 + 1, height: y1 - y0 + 1 });
    }
    return out;
}

/** The det plane fires on a band down the middle of a line, a third of a glyph thick. */
const DET_FLOOR = 0.05;
/** Unclip: a band of thickness t is grown by this much of t on each side. */
const DET_UNCLIP = 0.9;
/** Inside the unclipped band any visible step off the paper is ink. */
const BLOCK_INK_STEP = 10;

/**
 * BLK + DET: the pixels of one text block to erase.
 *
 * The block (the blk head's box around a balloon or caption) is the gate:
 * nothing outside it is touched. Inside it, the text is the det plane. That
 * plane is a shrunken band along each line, so every connected band is
 * unclipped by a share of its own thickness, which brings it out to the glyph
 * edges without reaching a strand of hair or a frame edge beside the line.
 *
 * On flat paper only the pixels in that zone that stand off the paper are
 * filled, minus ruled lines; off the paper the whole zone is the model's hole.
 */
function maskOfBlock(page: ImageData, planes: ErasePlanes, box: EraseBox): BoxMask | null {
    // The blk box can be tighter than the glyphs: a column with a white halo
    // kept its halo as two bars just outside the box.
    const rim = Math.max(4, Math.min(12, Math.round(Math.min(box.width, box.height) * 0.15)));
    const area = boundsOf(box, rim, page.width, page.height);
    const width = area.x1 - area.x0;
    const height = area.y1 - area.y0;
    if (width <= 0 || height <= 0) return null;
    const total = width * height;
    const kept = (pageX: number, pageY: number): boolean => (box.keep ?? []).some((rect) => (
        pageX >= rect.x && pageX < rect.x + rect.width && pageY >= rect.y && pageY < rect.y + rect.height
    ));

    const seed = new Uint8Array(total);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (planeAt(planes.det, area.x0 + x + 0.5, area.y0 + y + 0.5) >= DET_FLOOR) seed[y * width + x] = 1;
        }
    }
    // A band that belongs to kept text (a sound effect, a line with no
    // translation, or the furigana beside one) is not erased, nor is the
    // area its own unclip would cover. A band belongs to a keep rectangle when
    // most of it lies inside the rectangle grown across by most of its
    // thickness, which takes in the furigana printed beside the line.
    const keeps = (box.keep ?? []).map((rect) => {
        const reach = Math.min(rect.width, rect.height) * 0.8;
        return { x0: rect.x - reach, y0: rect.y - reach, x1: rect.x + rect.width + reach, y1: rect.y + rect.height + reach };
    });
    const guard = new Uint8Array(total);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (kept(area.x0 + x + 0.5, area.y0 + y + 0.5)) guard[y * width + x] = 1;
        }
    }
    // Unclip each band by its own thickness: bands of one radius are grown
    // together.
    const byRadius = new Map<string, { layer: Uint8Array; vertical: boolean }>();
    const guardByRadius = new Map<number, Uint8Array>();
    let widest = 3;
    for (const part of components(seed, width, height)) {
        const radius = Math.max(3, Math.min(40, Math.round(Math.min(part.width, part.height) * DET_UNCLIP)));
        const inside = keeps.length === 0 ? 0 : part.members.filter((index) => {
            const pageX = area.x0 + (index % width) + 0.5;
            const pageY = area.y0 + Math.floor(index / width) + 0.5;
            return keeps.some((rect) => pageX >= rect.x0 && pageX < rect.x1 && pageY >= rect.y0 && pageY < rect.y1);
        }).length;
        if (inside > part.members.length * 0.5) {
            const layer = guardByRadius.get(radius + 6) ?? new Uint8Array(total);
            for (const index of part.members) layer[index] = 1;
            guardByRadius.set(radius + 6, layer);
            continue;
        }
        widest = Math.max(widest, radius + Math.round(Math.min(part.width, part.height) / 2));
        const vertical = part.height >= part.width;
        const key = `${radius}:${vertical ? 'v' : 'h'}`;
        const entry = byRadius.get(key) ?? { layer: new Uint8Array(total), vertical };
        for (const index of part.members) entry.layer[index] = 1;
        byRadius.set(key, entry);
    }
    for (const [radius, layer] of guardByRadius) {
        const grown = grow(layer, width, height, radius);
        for (let index = 0; index < total; index += 1) if (grown[index] === 1) guard[index] = 1;
    }
    const zone = new Uint8Array(total);
    for (const [key, { layer, vertical }] of byRadius) {
        // A band is a shrunken column, not a shrunken blob: it is too thin, not
        // too short. Growing it across its width reaches the glyph edges; growing
        // it along its run pushed the mask past the top and bottom of the speech
        // and into the balloon wall, which is what a white smear over the wall
        // was. Two pixels along covers the soft end of a stroke.
        const radius = Number(key.split(':')[0]);
        const grown = vertical
            ? growRect(layer, width, height, radius, 2)
            : growRect(layer, width, height, 2, radius);
        for (let index = 0; index < total; index += 1) if (grown[index] === 1) zone[index] = 1;
    }
    let any = false;
    for (let index = 0; index < total; index += 1) {
        if (zone[index] !== 1) continue;
        if (guard[index] === 1) zone[index] = 0;
        else any = true;
    }
    if (!any) return null;

    // The paper: the block's pixels outside the text zone.
    const lumas: number[] = [];
    const reds: number[] = [];
    const greens: number[] = [];
    const blues: number[] = [];
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (zone[y * width + x] === 1) continue;
            const offset = ((area.y0 + y) * page.width + area.x0 + x) * 4;
            lumas.push(luma(page.data, offset));
            reds.push(page.data[offset]);
            greens.push(page.data[offset + 1]);
            blues.push(page.data[offset + 2]);
        }
    }
    const median = (values: number[]): number => values.slice().sort((left, right) => left - right)[values.length >> 1];
    const paperLuma = lumas.length > 0 ? median(lumas) : 255;
    const flat = lumas.length >= 16
        && lumas.filter((value) => Math.abs(value - paperLuma) <= FLAT_SPREAD).length / lumas.length >= FLAT_SHARE * 0.9;
    const colour: [number, number, number] = lumas.length > 0 ? [median(reds), median(greens), median(blues)] : [255, 255, 255];

    const flatMask = new Uint8Array(total);
    if (!flat) {
        // Off the paper the model fills the hole, and a whole band is too
        // big a hole on screentone or a star field: the model paints it flat.
        // The hole is the seg strokes near the band instead, a few pixels past
        // its edge so a glyph's halo goes with it.
        const strokes = new Uint8Array(total);
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                if (planeAt(planes.seg, area.x0 + x + 0.5, area.y0 + y + 0.5) >= SEG_NEAR) strokes[y * width + x] = 1;
            }
        }
        const hole = grow(strokes, width, height, 4);
        const reach = grow(zone, width, height, 6);
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const index = y * width + x;
                if (reach[index] !== 1 || guard[index] === 1) hole[index] = 0;
            }
        }
        return { area, flatMask, modelMask: hole, colour: null };
    }

    const ink = new Uint8Array(total);
    const strong = new Uint8Array(total);
    const paperish = new Uint8Array(total);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = y * width + x;
            const offset = ((area.y0 + y) * page.width + area.x0 + x) * 4;
            const step = Math.abs(luma(page.data, offset) - paperLuma);
            if (step <= FLAT_SPREAD) paperish[index] = 1;
            if (step > RULE_STEP) strong[index] = 1;
            if (zone[index] === 1 && step > BLOCK_INK_STEP) ink[index] = 1;
        }
    }
    const rules = grow(findRules(strong, width, height), width, height, 1);
    for (let index = 0; index < total; index += 1) if (rules[index] === 1) ink[index] = 0;
    // A glyph with a halo, or a stroke that pokes out of the band, keeps going
    // past the unclipped zone: the det plane is a shrunken band, and a column
    // whose band sits a few pixels off its ink leaves the tail of the last
    // glyph behind. The zone follows the ink outward until the ink stops, never
    // across a ruled line and never past a kept line. The walk ends by itself
    // when no dark pixel touches the zone, so a glyph is covered whole and the
    // paper around it is not; the cap only bounds a path that leaks into a
    // screentone.
    const reach = 8;
    for (let step = 0; step < reach; step += 1) {
        const next: number[] = [];
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const index = y * width + x;
                if (zone[index] === 1 || rules[index] === 1 || guard[index] === 1) continue;
                const offset = ((area.y0 + y) * page.width + area.x0 + x) * 4;
                if (Math.abs(luma(page.data, offset) - paperLuma) <= BLOCK_INK_STEP) continue;
                // Eight-way, so a stroke that steps diagonally is followed.
                if ((x > 0 && zone[index - 1] === 1) || (x < width - 1 && zone[index + 1] === 1)
                    || (y > 0 && zone[index - width] === 1) || (y < height - 1 && zone[index + width] === 1)
                    || (x > 0 && y > 0 && zone[index - width - 1] === 1)
                    || (x < width - 1 && y > 0 && zone[index - width + 1] === 1)
                    || (x > 0 && y < height - 1 && zone[index + width - 1] === 1)
                    || (x < width - 1 && y < height - 1 && zone[index + width + 1] === 1)) {
                    next.push(index);
                }
            }
        }
        if (next.length === 0) break;
        for (const index of next) {
            zone[index] = 1;
            ink[index] = 1;
        }
    }
    // Two pixels take the faint halo a JPEG leaves around every glyph.
    const strokes = grow(ink, width, height, 2);
    for (let index = 0; index < total; index += 1) if (zone[index] !== 1 || rules[index] === 1) strokes[index] = 0;

    // A stroke over art or screentone (a strand of hair that crosses the
    // line) is the model's; one with paper all around it is filled. A light
    // screentone is mostly white, so "paper" here means nearly all of it.
    // The surroundings are what lies outside the band, so the window reaches
    // past the half-width of the widest band.
    const radius = Math.min(48, widest + 6);
    const sumPaper = new Uint32Array((width + 1) * (height + 1));
    const sumOpen = new Uint32Array((width + 1) * (height + 1));
    for (let y = 0; y < height; y += 1) {
        let rowPaper = 0;
        let rowOpen = 0;
        for (let x = 0; x < width; x += 1) {
            const index = y * width + x;
            if (zone[index] !== 1) {
                rowOpen += 1;
                if (paperish[index] === 1) rowPaper += 1;
            }
            const at = (y + 1) * (width + 1) + x + 1;
            sumPaper[at] = sumPaper[at - width - 1] + rowPaper;
            sumOpen[at] = sumOpen[at - width - 1] + rowOpen;
        }
    }
    const windowSum = (sum: Uint32Array, x: number, y: number): number => {
        const left = Math.max(0, x - radius);
        const top = Math.max(0, y - radius);
        const right = Math.min(width, x + radius + 1);
        const bottom = Math.min(height, y + radius + 1);
        return sum[bottom * (width + 1) + right] - sum[top * (width + 1) + right]
            - sum[bottom * (width + 1) + left] + sum[top * (width + 1) + left];
    };
    // On paper the whole unclipped band is filled, not just the strokes: the
    // band edge is soft against JPEG noise, a glyph silhouette is not.
    const modelMask = new Uint8Array(total);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = y * width + x;
            if (zone[index] !== 1 || rules[index] === 1) continue;
            // The fill follows the strokes. It used to fill the whole zone, and
            // the zone is a band grown well past the glyph, so on paper the fill
            // was a white blob larger than the text — the "inpainting exceeds the
            // balloon" of a balloon whose wall the blob reached. The band's
            // interior is paper already, so filling it bought nothing.
            const open = windowSum(sumOpen, x, y);
            if (open !== 0 && windowSum(sumPaper, x, y) / open >= 0.9) {
                if (strokes[index] === 1) flatMask[index] = 1;
            } else if (strokes[index] === 1) {
                modelMask[index] = 1;
            }
        }
    }
    return { area, flatMask, modelMask, colour };
}


/** Cut a rectangle out of the page. */
function cut(page: ImageData, rect: Rect): ImageData {
    const width = rect.x1 - rect.x0;
    const height = rect.y1 - rect.y0;
    const out = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        const from = ((rect.y0 + y) * page.width + rect.x0) * 4;
        out.set(page.data.subarray(from, from + width * 4), y * width * 4);
    }
    return new ImageData(out, width, height);
}

/**
 * Tiles for the model. Each tile is a page window the model's square maps onto,
 * as close to 1:1 as the page allows: a 512 window around the text when the
 * text fits, a larger one scaled down only when it does not. Boxes that fit in
 * an open tile share it, so a page takes a handful of model runs.
 */
function planTiles(areas: Rect[], width: number, height: number): { rect: Rect; members: number[] }[] {
    const size = INPAINT_INPUT_SIZE;
    const order = areas.map((_, index) => index).sort((left, right) => areas[left].y0 - areas[right].y0 || areas[left].x0 - areas[right].x0);
    const done = new Set<number>();
    const tiles: { rect: Rect; members: number[] }[] = [];
    for (const index of order) {
        if (done.has(index)) continue;
        const area = areas[index];
        const context = 48;
        const side = Math.max(size, area.x1 - area.x0 + context * 2, area.y1 - area.y0 + context * 2);
        const tileWidth = Math.min(width, side);
        const tileHeight = Math.min(height, side);
        const centreX = (area.x0 + area.x1) / 2;
        const centreY = (area.y0 + area.y1) / 2;
        const x0 = Math.round(Math.min(Math.max(0, centreX - tileWidth / 2), width - tileWidth));
        const y0 = Math.round(Math.min(Math.max(0, centreY - tileHeight / 2), height - tileHeight));
        const rect = { x0, y0, x1: x0 + tileWidth, y1: y0 + tileHeight };
        const members: number[] = [];
        for (const other of order) {
            if (done.has(other)) continue;
            const candidate = areas[other];
            // A member keeps a little context on every side inside the tile.
            const margin = other === index ? 0 : 16;
            if (candidate.x0 - margin >= rect.x0 && candidate.x1 + margin <= rect.x1
                && candidate.y0 - margin >= rect.y0 && candidate.y1 + margin <= rect.y1) {
                members.push(other);
                done.add(other);
            }
        }
        if (!members.includes(index)) {
            members.push(index);
            done.add(index);
        }
        tiles.push({ rect, members });
    }
    return tiles;
}

/**
 * Erase the text under every box and return the page, transparent where
 * nothing was erased, so the overlay can show the paper underneath.
 *
 * A box on flat paper has its strokes filled with that paper: the model can
 * only guess at a flat colour, and a whole rectangle of paper wipes out any
 * frame or line that crosses the box. Every other box is inpainted in tiles at
 * page resolution, because a page squeezed into the model's 512 square drops
 * the thin strokes from the mask and the model paints the text back in.
 */
export async function erasePage(
    page: ImageData,
    planes: ErasePlanes,
    boxes: EraseBox[],
    inpaint: TileInpainter = (image, hole) => inpaintTile(image, hole, paperFallback(boxes)),
): Promise<{ data: Uint8ClampedArray; covered: number }> {
    const { width, height } = page;
    const data = new Uint8ClampedArray(width * height * 4);
    const work = new ImageData(new Uint8ClampedArray(page.data), width, height);
    let covered = 0;

    const masks = boxes.map((box) => (box.kind === 'block' ? maskOfBlock(page, planes, box) : maskOfBox(page, planes, box))).filter((entry): entry is BoxMask => entry !== null);

    for (const entry of masks) {
        const { area, flatMask, colour } = entry;
        if (!colour) continue;
        const localWidth = area.x1 - area.x0;
        for (let y = area.y0; y < area.y1; y += 1) {
            for (let x = area.x0; x < area.x1; x += 1) {
                if (flatMask[(y - area.y0) * localWidth + (x - area.x0)] !== 1) continue;
                const offset = (y * width + x) * 4;
                if (data[offset + 3] === 0) covered += 1;
                data[offset] = colour[0];
                data[offset + 1] = colour[1];
                data[offset + 2] = colour[2];
                data[offset + 3] = 255;
                work.data[offset] = colour[0];
                work.data[offset + 1] = colour[1];
                work.data[offset + 2] = colour[2];
            }
        }
    }

    const modelled = masks.filter((entry) => entry.modelMask.includes(1));
    if (modelled.length === 0) return { data, covered };
    const size = INPAINT_INPUT_SIZE;
    for (const tile of planTiles(modelled.map((entry) => entry.area), width, height)) {
        const { rect } = tile;
        const tileWidth = rect.x1 - rect.x0;
        const tileHeight = rect.y1 - rect.y0;
        // The hole at page resolution, inside this tile.
        const hole = new Uint8Array(tileWidth * tileHeight);
        for (const member of tile.members) {
            const { area, modelMask: mask } = modelled[member];
            const localWidth = area.x1 - area.x0;
            for (let y = Math.max(area.y0, rect.y0); y < Math.min(area.y1, rect.y1); y += 1) {
                for (let x = Math.max(area.x0, rect.x0); x < Math.min(area.x1, rect.x1); x += 1) {
                    if (mask[(y - area.y0) * localWidth + (x - area.x0)] === 1) {
                        hole[(y - rect.y0) * tileWidth + (x - rect.x0)] = 1;
                    }
                }
            }
        }
        // Into the model's square. A shrink keeps every hole pixel (max pool),
        // and one more pixel covers the blur of the resize on the way back.
        const scaleX = size / tileWidth;
        const scaleY = size / tileHeight;
        const square = new Uint8Array(size * size);
        for (let y = 0; y < tileHeight; y += 1) {
            for (let x = 0; x < tileWidth; x += 1) {
                if (hole[y * tileWidth + x] !== 1) continue;
                const sx = Math.min(size - 1, Math.floor(x * scaleX));
                const sy = Math.min(size - 1, Math.floor(y * scaleY));
                square[sy * size + sx] = 1;
            }
        }
        const resampled = scaleX !== 1 || scaleY !== 1;
        const holeSquare = resampled ? grow(square, size, size, 1) : square;
        const crop = cut(work, rect);
        const input = resampled ? scaleImage(crop, size, size) : crop;
        let painted: ImageData;
        try {
            painted = await inpaint(input, holeSquare);
        } catch (cause) {
            if (covered === 0) throw cause;
            console.warn('The inpaint pass failed for one tile; the flat fills stay.', cause);
            continue;
        }
        const back = resampled ? scaleImage(painted, tileWidth, tileHeight) : painted;
        for (let y = 0; y < tileHeight; y += 1) {
            for (let x = 0; x < tileWidth; x += 1) {
                if (hole[y * tileWidth + x] !== 1) continue;
                const source = (y * tileWidth + x) * 4;
                const offset = ((rect.y0 + y) * width + rect.x0 + x) * 4;
                if (data[offset + 3] === 0) covered += 1;
                for (let channel = 0; channel < 3; channel += 1) {
                    data[offset + channel] = back.data[source + channel];
                    work.data[offset + channel] = back.data[source + channel];
                }
                data[offset + 3] = 255;
            }
        }
    }
    return { data, covered };
}

/** The paper most of these boxes sit on, so a broken model still fills paper. */
function paperFallback(boxes: EraseBox[]): [number, number, number] {
    const tones = new Map<string, { paper: [number, number, number]; count: number }>();
    for (const box of boxes) {
        if (!box.paper) continue;
        const key = box.paper.join(',');
        const tone = tones.get(key) ?? { paper: box.paper, count: 0 };
        tone.count += 1;
        tones.set(key, tone);
    }
    let best: { paper: [number, number, number]; count: number } | undefined;
    for (const tone of tones.values()) {
        if (!best || tone.count > best.count) best = tone;
    }
    return best?.paper ?? [255, 255, 255];
}
