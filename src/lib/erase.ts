import { inpaintPage } from './inpaint';
import { refineMask } from './mask';
import { insidePolygon } from './rect';
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

/** One page rectangle to erase, with the paper behind it when it sits in a balloon. */
export type EraseBox = {
    x: number;
    y: number;
    width: number;
    height: number;
    angle?: number;
    /** Flat paper colour behind these glyphs, when the box is inside one balloon. */
    paper?: [number, number, number];
    /** Balloon outline in page pixels, so a paper fill stops at the wall. */
    clip?: { x: number; y: number }[];
};

/**
 * Erase the glyphs under every box and return the page, transparent where
 * nothing was erased, so the overlay can show the paper underneath.
 *
 * A box that sits on flat paper is filled with that colour and never reaches the
 * model: the inside of a balloon is one colour, and a generative fill can only
 * guess at it, which is how a whole balloon came back black. Everything else,
 * text over artwork, still goes through the one-page inpaint pass.
 */
export async function erasePage(
    page: ImageData,
    textMask: TextMask,
    boxes: EraseBox[],
    /** Injects the model pass, so a caller can supply its own or a stub. */
    inpaint: (mask: Uint8Array) => Promise<ImageData> = (mask) => inpaintPage(page, mask, paperFallback(boxes)),
): Promise<{ data: Uint8ClampedArray; covered: number }> {
    const width = page.width;
    const height = page.height;
    const data = new Uint8ClampedArray(width * height * 4);
    let covered = 0;

    const papered = boxes.filter((box) => box.paper
        && Array.isArray(box.clip) && box.clip.length >= 3);
    const modelled = boxes.filter((box) => !papered.includes(box));

    // One balloon tone is the common case, so the fills are grouped by colour
    // and each group takes one mask pass.
    const tones = new Map<string, { paper: [number, number, number]; lines: EraseBox[] }>();
    for (const box of papered) {
        const paper = box.paper as [number, number, number];
        const key = paper.join(',');
        const tone = tones.get(key) ?? { paper, lines: [] };
        tone.lines.push(box);
        tones.set(key, tone);
    }

    for (const { paper, lines } of tones.values()) {
        const clips = lines.map((box) => box.clip as { x: number; y: number }[]);
        let mask = refineMask(
            lines.map(asLine),
            textMask,
            width,
            height,
            (x, y) => clips.some((clip) => insidePolygon(clip, x, y)),
        );
        let filled = count(mask);
        if (filled === 0) {
            // The outline and the glyphs disagree. Filling a little paper over
            // the wall is better than leaving the original text on the page.
            console.warn('A balloon outline held no glyphs; filling without the clip.');
            mask = refineMask(lines.map(asLine), textMask, width, height);
            filled = count(mask);
        }
        if (filled === 0) continue;
        for (let index = 0; index < mask.length; index += 1) {
            if (mask[index] !== 1) continue;
            const offset = index * 4;
            data[offset] = paper[0];
            data[offset + 1] = paper[1];
            data[offset + 2] = paper[2];
            data[offset + 3] = 255;
            covered += 1;
        }
    }

    if (modelled.length > 0) {
        const mask = refineMask(modelled.map(asLine), textMask, width, height);
        if (count(mask) > 0) {
            // A model that fails must not cost the balloons their fill, so its
            // error is only fatal when there is nothing else to show.
            let painted: ImageData | null = null;
            try {
                painted = await inpaint(mask);
            } catch (cause) {
                if (covered === 0) throw cause;
                console.warn('The inpaint pass failed; the balloon paper was still filled.', cause);
            }
            if (painted) {
                for (let index = 0; index < mask.length; index += 1) {
                    if (mask[index] !== 1) continue;
                    const offset = index * 4;
                    data[offset] = painted.data[offset];
                    data[offset + 1] = painted.data[offset + 1];
                    data[offset + 2] = painted.data[offset + 2];
                    data[offset + 3] = 255;
                    covered += 1;
                }
            }
        }
    }

    return { data, covered };
}

function count(mask: Uint8Array): number {
    let total = 0;
    for (const value of mask) if (value === 1) total += 1;
    return total;
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

function asLine(box: EraseBox): Box {
    return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        score: 1,
        angle: box.angle,
    };
}
