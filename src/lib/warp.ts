import type { Box, Point } from './types';

/**
 * A line that sits at an angle still needs an upright crop. The frame holds the
 * centre, the two unit vectors of the text, and the size of the crop.
 */
export type LineUpright = {
    centre: Point;
    along: Point;
    across: Point;
    width: number;
    height: number;
};

export function angleOf(box: Box): number {
    return box.angle ?? 0;
}

/** Size of the upright crop: length along the text by thickness across it. */
export function cropSize(box: Box): { width: number; height: number } {
    const angle = angleOf(box);
    if (Math.abs(angle) < 0.01) {
        return { width: Math.max(1, Math.round(box.width)), height: Math.max(1, Math.round(box.height)) };
    }
    return {
        width: Math.max(1, Math.round(box.lineLength ?? box.width)),
        height: Math.max(1, Math.round(box.lineThickness ?? box.height)),
    };
}

export function uprightFrame(box: Box): LineUpright {
    const angle = angleOf(box);
    const { width, height } = cropSize(box);
    return {
        centre: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        along: { x: Math.cos(angle), y: Math.sin(angle) },
        across: { x: -Math.sin(angle), y: Math.cos(angle) },
        width,
        height,
    };
}

/** Map a pixel of the upright crop back to page pixels. */
export function pagePointAt(frame: LineUpright, x: number, y: number): Point {
    const dx = x - frame.width / 2;
    const dy = y - frame.height / 2;
    return {
        x: frame.centre.x + dx * frame.along.x + dy * frame.across.x,
        y: frame.centre.y + dx * frame.along.y + dy * frame.across.y,
    };
}

/** Draw a line into a canvas with the angle removed, so it reads upright. */
export function drawUpright(
    context: CanvasRenderingContext2D,
    bitmap: ImageBitmap,
    box: Box,
    width: number,
    height: number,
): void {
    const frame = uprightFrame(box);
    context.save();
    context.translate(width / 2, height / 2);
    context.rotate(-angleOf(box));
    context.translate(-frame.centre.x, -frame.centre.y);
    context.drawImage(bitmap, 0, 0);
    context.restore();
}
