/**
 * The on-device reading of a block, cut into the columns it holds.
 *
 * The cloud reader names the lines of a block but its transcription of a
 * small, leaned column is a guess: on the 四十歲 page it read ヒーローものは as
 * ヒィロ…モッは, and on a bad run it dropped the column altogether. The
 * recogniser trained on printed manga does not have that problem once the
 * column is upright and alone in the crop, so its reading is taken here and
 * handed to the reader as a reference.
 *
 * The columns are found from the segmentation plane, not from the detector: the
 * detector merges the three columns of a speech into one box, and an axis
 * aligned split of that box cuts across the columns because they are leaned.
 * The ink is measured in a frame rotated by the lean instead, where a column is
 * a band of the across axis. The lean itself is not measurable from that ink —
 * three leaned columns two pixels apart are one blob — so the recogniser is
 * asked, and the lean whose bands it reads most decisively wins.
 */

import { majorAxis } from '../rect';
import { MODEL_SIZE } from '../mask';
import type { TextMask, OcrResult } from '../types';
import { recognizeLine } from './recognize';

/** A crop the on-device recogniser read, in page pixels. */
export type HintLine = {
    text: string;
    confidence: number;
    box: { x: number; y: number; width: number; height: number };
};

export type BlockHint = {
    /** The columns the recogniser read, in reading order: right to left. */
    lines: HintLine[];
    /** Lean the crops were uprighted by, in radians, in the pipeline's sign. */
    lean: number;
    /** How many columns the block was cut into. */
    columns: number;
};

type Box = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

/**
 * Characters a full column holds, which turns the block's height into the size
 * of one glyph. It is the only measure of a glyph available before the reader
 * answers, and a column of manga dialogue runs six to eight characters deep.
 */
const GLYPHS_PER_COLUMN = 8;

/**
 * The ink of one block, in page pixels.
 *
 * Only compact blobs count. A panel edge, a balloon wall or a screentone band
 * crosses the block and is one long component; a glyph is a small one. The
 * filter is what makes the histogram below a picture of the text rather than of
 * the artwork behind it: on the TV speech the unfiltered ink reached 25 pixels
 * past the first column, and every band was cut in the wrong place.
 */
export function blockInk(mask: TextMask, block: Box): Point[] {
    const inset = 1;
    const width = Math.ceil(block.width * mask.scale) + 2;
    const height = Math.ceil(block.height * mask.scale) + 2;
    const originX = Math.floor(block.x * mask.scale + mask.padX) - inset;
    const originY = Math.floor(block.y * mask.scale + mask.padY) - inset;
    const ink = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const at = (originY + y) * MODEL_SIZE + (originX + x);
            ink[y * width + x] = (mask.data[at] ?? 0) > 0.25 ? 1 : 0;
        }
    }

    const seen = new Uint8Array(width * height);
    const points: Point[] = [];
    for (let start = 0; start < width * height; start += 1) {
        if (ink[start] === 0 || seen[start] === 1) continue;
        const stack = [start];
        seen[start] = 1;
        const cells: number[] = [];
        let touchesEdge = false;
        while (stack.length > 0) {
            const at = stack.pop() as number;
            const x = at % width;
            const y = (at - x) / width;
            if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
            cells.push(at);
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nextX = x + dx;
                const nextY = y + dy;
                if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
                const next = nextY * width + nextX;
                if (ink[next] === 1 && seen[next] === 0) {
                    seen[next] = 1;
                    stack.push(next);
                }
            }
        }
        // A blob that runs off the crop is the edge of the panel or a column
        // the block does not hold; a glyph is whole.
        if (touchesEdge) continue;
        // A noisy speck is not a glyph, and a component larger than a glyph is
        // artwork. The bounds are generous: a big kanji on a 1600 pixel page is
        // about 60 pixels a side, which is 1400 mask pixels at this scale.
        if (cells.length < 4 || cells.length > 900) continue;
        for (const at of cells) {
            const x = at % width;
            const y = (at - x) / width;
            points.push({
                x: (originX + x - mask.padX) / mask.scale,
                y: (originY + y - mask.padY) / mask.scale,
            });
        }
    }
    return points;
}

/** The `columns` bands of one block along its across axis, in page pixels. */
function bandsOf(points: Point[], columns: number, lean: number): Box[] {
    const cos = Math.cos(lean);
    const sin = Math.sin(lean);
    const across = points.map((point) => point.x * cos + point.y * sin);
    const along = points.map((point) => -point.x * sin + point.y * cos);
    const from = Math.min(...across);
    const to = Math.max(...across);
    const step = (to - from) / columns;
    const bands: Box[] = [];
    for (let index = 0; index < columns; index += 1) {
        const low = from + step * index;
        const high = low + step;
        let alongFrom = Number.POSITIVE_INFINITY;
        let alongTo = Number.NEGATIVE_INFINITY;
        across.forEach((value, at) => {
            if (value < low || value > high) return;
            alongFrom = Math.min(alongFrom, along[at]);
            alongTo = Math.max(alongTo, along[at]);
        });
        if (!(alongTo > alongFrom)) continue;
        const acrossCentre = (low + high) / 2;
        const alongCentre = (alongFrom + alongTo) / 2;
        const thickness = high - low;
        const length = alongTo - alongFrom;
        bands.push({
            x: acrossCentre * cos - alongCentre * sin - thickness / 2,
            y: acrossCentre * sin + alongCentre * cos - length / 2,
            width: thickness,
            height: length,
        });
    }
    return bands;
}

/** One band read on device, with the lean its crop was uprighted by. */
async function readBand(
    bitmap: ImageBitmap,
    band: Box,
    lean: number,
): Promise<OcrResult> {
    const height = Math.max(1, band.height);
    const crop = {
        x: band.x,
        y: band.y,
        width: band.width,
        height,
        score: 1,
        angle: lean,
        lineLength: height,
        lineThickness: band.width,
    };
    return recognizeLine(bitmap, crop, true).catch(() => ({ text: '', confidence: 0 }));
}

/**
 * How believable one cut of a block is.
 *
 * A band that reads nothing is normal on a detector box that reaches past the
 * text; a band that reads with no confidence is a bad cut, because the
 * recogniser is decisive on a column it can see. A long word in a band too
 * narrow to hold it is two columns the cut merged, which is the failure this
 * reference exists to avoid. The score is per band so a block cut into four
 * does not beat a block cut into three just by having more bands.
 */
function scoreOf(lines: { text: string; confidence: number; width: number; length: number }[]): number {
    let total = 0;
    for (const line of lines) {
        const glyphs = [...line.text].length;
        if (glyphs === 0) continue;
        const fits = line.length / Math.max(1, line.width);
        if (glyphs > fits * 1.2 + 1) {
            total -= 0.5;
            continue;
        }
        total += line.confidence >= 0.5 ? line.confidence : -0.4;
    }
    return total / Math.max(1, lines.length);
}

/** Whether two readings are the same column read twice. */
export function similar(left: string, right: string): boolean {
    const a = [...left.replace(/[\s、。！？…「」『』]/gu, '')];
    const b = [...right.replace(/[\s、。！？…「」『』]/gu, '')];
    if (a.length < 2 || b.length < 2) return false;
    const shared = a.filter((glyph) => b.includes(glyph)).length;
    return shared / Math.min(a.length, b.length) >= 0.5;
}

/** Where the block's ink stands in the across axis at one lean. */
function extentOf(points: Point[], lean: number): number {
    const cos = Math.cos(lean);
    const sin = Math.sin(lean);
    const across = points.map((point) => point.x * cos + point.y * sin);
    return Math.max(...across) - Math.min(...across);
}

/**
 * Read one block on device, one crop per column.
 *
 * The column count comes from the ink: a block eight glyphs deep and wider than
 * two glyphs holds more than one column. The lean does not: the ink of three
 * leaned columns is one blob, and its major axis is the diagonal of the run,
 * which is neither the columns' direction nor its sign. A projection profile is
 * no better — the columns are two pixels apart and the profile's spread follows
 * the extent, not the gaps. The recogniser is the only thing that can tell a
 * straight column from a slanted one, so the leans are tried and the cut that
 * reads most decisively wins.
 *
 * The reading is a reference, never the answer: it is the reader that sees the
 * page.
 */
export async function readBlockHint(
    bitmap: ImageBitmap,
    block: Box,
    mask: TextMask | null,
    /**
     * Blue boxes the detector drew inside this block. When it drew one per
     * column the reader already has the columns and reads them; the reference
     * is for the block where the detector merged them into one.
     */
    placed = 0,
): Promise<BlockHint | null> {
    if (!mask) return null;
    const points = blockInk(mask, block);
    if (points.length < 40) return null;

    // The whole block's axis, measured from upright: the diagonal of a three
    // column speech, which is the wrong direction for a column and the right
    // one for how far the run reaches across.
    const axis = majorAxis(points);
    const groupLean = axis === null ? 0 : (axis < 0 ? axis + Math.PI / 2 : axis - Math.PI / 2);
    const glyph = Math.max(12, block.height / GLYPHS_PER_COLUMN);
    const across = extentOf(points, groupLean);
    if (!(across > 0)) return null;

    const widest = Math.max(1, Math.min(4, Math.round(across / glyph)));
    // Two blue boxes short of the ink is the case this reference exists for: the
    // detector merged the columns, the reader follows the rectangles, and a
    // column it did not name is a column it does not read. One box short is a
    // detector that split a column or a short final line, not a lost column.
    if (placed > widest - 2) return null;
    // One column is not under-boxed: the detector drew it, and the reader reads
    // it without help.
    if (widest <= 1) return null;

    const readCut = async (columns: number, lean: number): Promise<BlockHint> => {
        const readings: HintLine[] = [];
        for (const band of bandsOf(points, columns, lean)) {
            const result = await readBand(bitmap, band, lean);
            readings.push({ text: result.text, confidence: result.confidence, box: band });
        }
        return { lines: readings, lean, columns };
    };
    const scoreOfCut = (cut: BlockHint): number => scoreOf(cut.lines.map((line) => ({
        text: line.text,
        confidence: line.confidence,
        width: line.box.width,
        length: line.box.height,
    })));

    // The leans are tried rather than measured: this block's own axis is the
    // diagonal of its run, and the segmentation plane has no other direction to
    // offer on a box that holds three columns two pixels apart. The step is wide
    // enough to cover a block laid down the page at an angle and a column that
    // leans the other way; -16 is the TV speech, 0 the captions.
    let best = await readCut(widest, groupLean);
    let bestScore = scoreOfCut(best);
    for (const degrees of [-16, -8, 0, 8, 16]) {
        if (Math.abs(degrees - best.lean * 180 / Math.PI) < 0.01) continue;
        const cut = await readCut(widest, degrees * Math.PI / 180);
        const score = scoreOfCut(cut);
        if (score > bestScore) {
            best = cut;
            bestScore = score;
        }
    }
    // One column fewer, at the winning lean: the extent estimate rounds up on a
    // speech whose first column is shorter than its last, and a cut with a
    // column that reads nothing is a cut that split one of them.
    const shaky = best.lines.some((line) => line.text.trim().length === 0 || line.confidence < 0.7)
        || best.lines.some((line, at) => best.lines.some((other, otherAt) => (
            at < otherAt && similar(line.text, other.text)
        )));
    if (shaky && widest > 2) {
        const cut = await readCut(widest - 1, best.lean);
        if (scoreOfCut(cut) > bestScore) {
            best = cut;
            bestScore = scoreOfCut(cut);
        }
    }
    // The reference is only given when it is trustworthy. A cut with a column
    // that read nothing, a reading the recogniser itself was unsure of, or one
    // column read twice tells the reader something false about the page, and a
    // false line is worse than no reference at all: the reader would either
    // translate it or stop looking for the column it replaced.
    const reliable = best.lines.every((line, at) => (
        line.text.trim().length > 0
        && line.confidence >= 0.7
        && !best.lines.some((other, otherAt) => at !== otherAt && similar(line.text, other.text))
    ));
    if (!reliable) return null;
    // Reading order: vertical columns run right to left.
    best.lines.sort((left, right) => (right.box.x + right.box.width / 2) - (left.box.x + left.box.width / 2));
    return best;
}
