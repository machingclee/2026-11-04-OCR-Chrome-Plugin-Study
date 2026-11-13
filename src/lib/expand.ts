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
        if (bandInk(mask, box, offset, side, vertical) >= INK) lastInk = offset;
        else if (offset - lastInk > gapBudget) break;
    }
    return lastInk;
}

/**
 * The detector sometimes stops a glyph or two early, so the end of a column sits
 * outside its own box. The seg mask marks the strokes, so the box walks out to
 * the last stroke it can reach.
 */
export function expandToInk(box: Box, mask: TextMask | null, regions: PageRect[] = []): Box {
    if (!mask) return box;
    // A leaned hull is already the glyph rectangle. Growing the page box would
    // slide its centre and the rotation would miss the text.
    if (Math.abs(box.angle ?? 0) >= 0.01) return box;

    const vertical = box.height >= box.width;
    const start = grow(box, mask, 'start', vertical, regions);
    const end = grow(box, mask, 'end', vertical, regions);
    if (start === 0 && end === 0) return box;

    if (vertical) {
        return { ...box, y: box.y - start, height: box.height + start + end };
    }
    return { ...box, x: box.x - start, width: box.width + start + end };
}
