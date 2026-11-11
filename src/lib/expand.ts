import type { Box, TextMask } from './types';

const MODEL_SIZE = 1024;
const STEP = 3;
const INK = 0.12;
/** Look this far ahead so a gap between two glyphs does not stop the growth. */
const LOOKAHEAD = 2;

function inkAt(mask: TextMask, pageX: number, pageY: number): number {
    const x = Math.round(pageX * mask.scale + mask.padX);
    const y = Math.round(pageY * mask.scale + mask.padY);
    if (x < 0 || y < 0 || x >= MODEL_SIZE || y >= MODEL_SIZE) return 0;
    return mask.data[y * MODEL_SIZE + x];
}

/** Mean stroke coverage on the strip just outside one end of a box. */
function edgeInk(mask: TextMask, box: Box, side: 'start' | 'end', vertical: boolean): number {
    const samples = 9;
    let best = 0;
    for (let index = 0; index < samples; index += 1) {
        const fraction = (index + 0.5) / samples;
        if (vertical) {
            const x = box.x + box.width * fraction;
            const y = side === 'start' ? box.y - STEP : box.y + box.height + STEP;
            best = Math.max(best, inkAt(mask, x, y));
        } else {
            const y = box.y + box.height * fraction;
            const x = side === 'start' ? box.x - STEP : box.x + box.width + STEP;
            best = Math.max(best, inkAt(mask, x, y));
        }
    }
    return best;
}

/** True when any of the next few steps still shows a stroke. */
function reachInk(mask: TextMask, box: Box, side: 'start' | 'end', vertical: boolean): boolean {
    for (let step = 1; step <= LOOKAHEAD; step += 1) {
        const offset = STEP * step;
        const probe: Box = { ...box };
        if (vertical) probe.y = side === 'start' ? box.y - offset : box.y + offset;
        else probe.x = side === 'start' ? box.x - offset : box.x + offset;
        if (edgeInk(mask, probe, side, vertical) >= INK) return true;
    }
    return false;
}

/**
 * Walk the ends of a line outward while the mask still shows strokes there. The
 * detector sometimes stops at the first glyph, which leaves the top of a column
 * outside its own box, and the crop then misses that character.
 */
export function expandToInk(box: Box, mask: TextMask | null): Box {
    if (!mask) return box;

    const vertical = box.height >= box.width;
    const thickness = vertical ? box.width : box.height;
    const limit = Math.round(thickness * 0.9);
    let grown = 0;
    let { x, y, width, height } = box;

    while (grown < limit) {
        const current: Box = { ...box, x, y, width, height };
        if (reachInk(mask, current, 'start', vertical) === false) break;
        if (vertical) {
            y -= STEP;
            height += STEP;
        } else {
            x -= STEP;
            width += STEP;
        }
        grown += STEP;
    }

    grown = 0;
    while (grown < limit) {
        const current: Box = { ...box, x, y, width, height };
        if (reachInk(mask, current, 'end', vertical) === false) break;
        if (vertical) {
            height += STEP;
        } else {
            width += STEP;
        }
        grown += STEP;
    }

    return { ...box, x, y, width, height };
}
