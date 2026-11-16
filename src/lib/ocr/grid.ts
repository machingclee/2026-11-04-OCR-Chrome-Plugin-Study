/**
 * The grid drawn on a block crop before it goes to the reader.
 *
 * Asking a vision model where a line sits, as a fraction of the crop, is a
 * measurement, and its measurements were wrong often enough that a line landed
 * beside its column. Drawing the grid onto the image turns the same question
 * into a reading: the lines are visible, the numbers are printed, and the
 * answer is a cell coordinate that becomes page pixels with one multiplication.
 *
 * One cell is `GRID_CELL` page pixels, widened only when a crop is so large
 * that its grid would be unreadable.
 */

/** Smallest cell, in page pixels. */
export const GRID_CELL = 4;
/** Cells the long side is divided into. */
const CELLS_LONG = 20;

export type CropBox = { x: number; y: number; width: number; height: number };

/**
 * Size of one cell for a crop, in page pixels.
 *
 * The long side carries about sixteen cells: enough lines to read a character's
 * width off the grid, few enough that the grid does not bury the text it is
 * meant to help measure. A finer grid was tried and the lines crowded out the
 * kanji.
 */
export function gridCell(crop: CropBox): number {
    const long = Math.max(1, Math.max(crop.width, crop.height));
    return Math.max(GRID_CELL, Math.round(long / CELLS_LONG));
}

export type GridGeometry = {
    /** Page pixels per cell. */
    cell: number;
    /** Cells that fit across the crop, rounded down. */
    columns: number;
    /** Cells that fit down the crop, rounded down. */
    rows: number;
};

export function gridGeometry(crop: CropBox, cell = gridCell(crop)): GridGeometry {
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
const MINOR = 'rgba(15, 23, 42, 0.16)';
const MAJOR = 'rgba(15, 23, 42, 0.4)';
/** Columns are numbered in blue along the top, rows in red along the left. */
const COLUMN_INK = '#1d4ed8';
const ROW_INK = '#b91c1c';
/** Every fifth line is drawn thicker. */
const MAJOR_EVERY = 5;

/**
 * Paint the grid onto a canvas that already holds the upscaled crop.
 *
 * `scale` is page pixels to canvas pixels, so a line stays on the cell it
 * belongs to and a number says what a cell index means without the model
 * counting lines from the edge.
 */
export function paintGrid(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    geometry: GridGeometry,
    scale: number,
): void {
    const { cell, columns, rows } = geometry;
    const at = (index: number): number => Math.round(index * cell * scale);
    const edge = Math.max(1, Math.round(cell * scale * 0.12));

    context.save();
    context.lineWidth = edge;
    for (let index = 0; index <= columns; index += 1) {
        const x = at(index);
        if (x > width) break;
        context.strokeStyle = index % MAJOR_EVERY === 0 ? MAJOR : MINOR;
        context.beginPath();
        context.moveTo(x + 0.5, 0);
        context.lineTo(x + 0.5, height);
        context.stroke();
    }
    for (let index = 0; index <= rows; index += 1) {
        const y = at(index);
        if (y > height) break;
        context.strokeStyle = index % MAJOR_EVERY === 0 ? MAJOR : MINOR;
        context.beginPath();
        context.moveTo(0, y + 0.5);
        context.lineTo(width, y + 0.5);
        context.stroke();
    }

    // Every line is numbered, not every fifth. Interpolating between 0 and 5
    // was where the reader went wrong: it guessed a scale from the row numbers
    // and answered a column the grid did not have. A number on every line
    // removes the interpolation.
    //
    // The numbers sit in the top strip and the left strip, where the crop's
    // padding usually is. A comic page can be dark and busy, so each number
    // gets a white chip behind it rather than a halo: a halo disappears over
    // screentone, and a number the reader cannot read is a number it invents.
    const size = Math.max(9, Math.round(cell * scale * 0.55));
    context.font = `bold ${size}px "Helvetica Neue", Arial, sans-serif`;
    context.textBaseline = 'top';
    const chip = (label: string, x: number, y: number, ink: string): void => {
        const room = context.measureText(label).width;
        const left = Math.max(0, Math.min(x, width - room - 3));
        const top = Math.max(0, Math.min(y, height - size - 2));
        context.fillStyle = 'rgba(255, 255, 255, 0.88)';
        context.fillRect(left - 1, top - 1, room + 4, size + 2);
        context.fillStyle = ink;
        context.textAlign = 'left';
        context.fillText(label, left + 1, top);
    };
    for (let index = 0; index <= columns; index += 1) {
        const x = at(index);
        if (x > width) break;
        chip(String(index), x + 2, 1, COLUMN_INK);
    }
    for (let index = 1; index <= rows; index += 1) {
        const y = at(index);
        if (y > height) break;
        chip(String(index), 1, y + 1, ROW_INK);
    }
    context.restore();
}
