/**
 * The grid drawn on a block crop before it goes to the reader.
 *
 * Asking a vision model where a line sits, as a fraction of the crop, is a
 * measurement out of thin air, and its measurements were wrong often enough
 * that a line landed beside its column. Drawing the grid onto the image turns
 * the question into a reading: the lines are visible, and every line carries the
 * page coordinate it sits on, so the answer is a number printed on the image
 * rather than a cell counted off its edge.
 *
 * The count was the drift. A cell of the coarse grid was as wide as a
 * character, so a 30px glyph that touched two 25px cells was reported as two
 * cells wide: the font doubled and the label, centred on the doubled box, sat
 * half a character beside its column. A grid of about `CELL_SPACING` canvas
 * pixels between lines, with the page pixels printed on them, asks for the
 * coordinate instead of the count.
 */

/** Smallest cell, in page pixels. */
export const GRID_CELL = 4;
/** The long side is divided into at most this many cells. */
const CELLS_LONG = 120;
/** Canvas pixels between two grid lines: three or four lines across a glyph. */
const CELL_SPACING = 20;
/** Every fifth line is drawn thicker and prints its index. */
const MAJOR_EVERY = 5;

export type CropBox = { x: number; y: number; width: number; height: number };

/**
 * Size of one cell for a crop, in page pixels.
 *
 * Two floors apply and the larger wins: a cell big enough to leave
 * `CELL_SPACING` canvas pixels between lines once the crop is upscaled, so the
 * numbers stay legible, and a cell big enough that a very long crop does not get
 * a line every few pixels. Neither is related to the crop's own size the way the
 * old twenty-cell grid was, which is what made one cell a whole character.
 */
export function gridCell(crop: CropBox, scale: number): number {
    const long = Math.max(1, Math.max(crop.width, crop.height));
    const room = Math.round(CELL_SPACING / Math.max(0.1, scale));
    const span = Math.round(long / CELLS_LONG);
    return Math.max(GRID_CELL, room, span);
}

export type GridGeometry = {
    /** Page pixels per cell. */
    cell: number;
    /** Cells that fit across the crop, rounded down. */
    columns: number;
    /** Cells that fit down the crop, rounded down. */
    rows: number;
};

export function gridGeometry(crop: CropBox, cell: number): GridGeometry {
    return {
        cell,
        columns: Math.max(1, Math.floor(crop.width / cell)),
        rows: Math.max(1, Math.floor(crop.height / cell)),
    };
}

/** Where a line sits, in cells counted from the crop's top left corner. */
export type CellBox = {
    x: number;
    y: number;
    width: number;
    height: number;
};

/** The page pixels of a cell box. */
export function cellToPage(crop: CropBox, cell: number, box: CellBox): { x: number; y: number; width: number; height: number } {
    return {
        x: crop.x + box.x * cell,
        y: crop.y + box.y * cell,
        width: box.width * cell,
        height: box.height * cell,
    };
}

// Neutral lines, so the blue boxes drawn over them stay unmistakable.
const MINOR = 'rgba(15, 23, 42, 0.18)';
const MAJOR = 'rgba(15, 23, 42, 0.45)';
/** Columns are numbered in blue along the top, rows in red along the left. */
const COLUMN_INK = '#1d4ed8';
const ROW_INK = '#b91c1c';
/** The cell index, where it is printed at all. */
const INDEX_INK = '#6b7280';

/**
 * Paint the grid onto a canvas that already holds the upscaled crop.
 *
 * `scale` is page pixels to canvas pixels, and `origin` is the page pixel at the
 * canvas's top left corner: the number on a line is that line's page x or y, so
 * the answer needs no multiplication and no counting.
 */
export function paintGrid(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    geometry: GridGeometry,
    scale: number,
    origin: { x: number; y: number },
): void {
    const { cell, columns, rows } = geometry;
    const at = (index: number): number => Math.round(index * cell * scale);
    const edge = Math.max(1, Math.round(cell * scale * 0.07));
    const major = Math.max(edge + 1, Math.round(cell * scale * 0.14));

    context.save();
    for (let index = 0; index <= columns; index += 1) {
        const x = at(index);
        if (x > width) break;
        context.lineWidth = index % MAJOR_EVERY === 0 ? major : edge;
        context.strokeStyle = index % MAJOR_EVERY === 0 ? MAJOR : MINOR;
        context.beginPath();
        context.moveTo(x + 0.5, 0);
        context.lineTo(x + 0.5, height);
        context.stroke();
    }
    for (let index = 0; index <= rows; index += 1) {
        const y = at(index);
        if (y > height) break;
        context.lineWidth = index % MAJOR_EVERY === 0 ? major : edge;
        context.strokeStyle = index % MAJOR_EVERY === 0 ? MAJOR : MINOR;
        context.beginPath();
        context.moveTo(0, y + 0.5);
        context.lineTo(width, y + 0.5);
        context.stroke();
    }

    // The numbers are the whole point: one per line, on both edges, carrying
    // the page coordinate rather than a count. A comic page can be dark and
    // busy, so each one gets a white chip behind it instead of a halo: a halo
    // disappears over screentone, and a number the reader cannot read is a
    // number it invents.
    //
    // The column numbers are laid flat and staggered over two rows rather than
    // turned a quarter turn. Turned, they cost the reader a rotation to read and
    // it fumbled them: asked for the top row it returned 62 for the line printed
    // 42 and then answered the boxes from an estimate. Laid flat they read like
    // the row numbers, which it got right on the first try.
    const size = Math.max(8, Math.min(11, Math.round(cell * scale * 0.5)));
    const indexSize = Math.max(6, Math.min(8, Math.round(size * 0.8)));
    const row = size + 3;
    context.textBaseline = 'top';
    context.textAlign = 'left';

    const chip = (text: string, left: number, top: number, ink: string, font: string): void => {
        context.font = font;
        const room = context.measureText(text).width;
        context.fillStyle = 'rgba(255, 255, 255, 0.9)';
        context.fillRect(left - 1, top - 1, room + 4, size + 2);
        context.fillStyle = ink;
        context.fillText(text, left + 1, top);
    };

    for (let index = 0; index <= columns; index += 1) {
        const x = at(index);
        if (x > width - 1) break;
        const label = String(Math.round(origin.x + index * cell));
        const room = context.measureText(label).width;
        const left = Math.min(Math.max(0, x + 1), Math.max(0, width - room - 4));
        const top = index % 2 === 0 ? 2 : 2 + row;
        chip(label, left, top, COLUMN_INK, `bold ${size}px "Helvetica Neue", Arial, sans-serif`);
        if (index % MAJOR_EVERY === 0) {
            // The index stays on the image, beside the coordinate it belongs to,
            // for a reader that still counts. It is not the answer any more.
            context.font = `${indexSize}px "Helvetica Neue", Arial, sans-serif`;
            const mark = String(index);
            context.fillStyle = 'rgba(255, 255, 255, 0.85)';
            context.fillRect(left - 1, top + row - 1, context.measureText(mark).width + 3, indexSize + 2);
            context.fillStyle = INDEX_INK;
            context.fillText(mark, left, top + row);
        }
    }
    for (let index = 1; index <= rows; index += 1) {
        const y = at(index);
        if (y > height - 1) break;
        const top = Math.min(y + 1, Math.max(0, height - size - 2));
        const label = String(Math.round(origin.y + index * cell));
        chip(label, 1, top, ROW_INK, `bold ${size}px "Helvetica Neue", Arial, sans-serif`);
        if (index % MAJOR_EVERY === 0) {
            const room = context.measureText(label).width;
            context.font = `${indexSize}px "Helvetica Neue", Arial, sans-serif`;
            context.fillStyle = 'rgba(255, 255, 255, 0.85)';
            context.fillRect(room + 4, top, context.measureText(String(index)).width + 3, indexSize + 2);
            context.fillStyle = INDEX_INK;
            context.fillText(String(index), room + 5, top + 1);
        }
    }
    context.restore();
}
