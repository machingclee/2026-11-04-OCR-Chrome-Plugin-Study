import type { GroupData } from '../shared/types';
import { canStartLine, safeBreak, squeeze, toVertical } from './punct';

type Paragraph = { box: GroupData; text: string; columns?: string[]; outline?: { x: number; y: number }[] };

export type TypesetOptions = {
    /** The font family the page is lettered in. */
    family: string;
    /** Multiplier for the gap between lines, 1 is tight and 1.4 is airy. */
    leading: number;
};

const DEFAULT_OPTIONS: TypesetOptions = {
    family: 'system-ui, "PingFang TC", sans-serif',
    leading: 1.15,
};

function isVertical(box: { width: number; height: number }): boolean {
    return box.height > box.width * 1.3;
}

/** Keep the paint inside the balloon, so nothing spills over the artwork. */
function clipTo(context: CanvasRenderingContext2D, group: Paragraph): void {
    const outline = group.outline;
    if (!outline || outline.length < 3) {
        context.beginPath();
        context.rect(group.box.x, group.box.y, group.box.width, group.box.height);
        context.clip();
        return;
    }
    context.beginPath();
    outline.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
    });
    context.closePath();
    context.clip();
}

/** Break a string into lines that fit the width of the box. */
function wrap(context: CanvasRenderingContext2D, text: string, width: number): string[] {
    const lines: string[] = [];
    let current = '';
    for (const character of text) {
        const next = current + character;
        if (context.measureText(next).width > width && current.length > 0) {
            // A closing mark stays on the line it closes, even if it spills.
            if (!canStartLine(character)) {
                current = next;
                continue;
            }
            lines.push(current);
            current = character;
        } else {
            current = next;
        }
    }
    if (current.length > 0) lines.push(current);
    return lines;
}

function inner(box: GroupData): { x: number; y: number; width: number; height: number } {
    const pad = Math.max(3, Math.min(box.width, box.height) * 0.14);
    return {
        x: box.x + pad,
        y: box.y + pad,
        width: Math.max(8, box.width - pad * 2),
        height: Math.max(8, box.height - pad * 2),
    };
}

function drawHorizontal(context: CanvasRenderingContext2D, box: GroupData, text: string, options: TypesetOptions): void {
    const area = inner(box);
    // Start small enough that a short line cannot turn into a headline.
    // Binary search the largest size that still fits, so short lines grow.
    let low = 7;
    let high = Math.max(8, Math.min(area.width, area.height));
    let best = 7;
    let bestLines: string[] = [];
    while (low <= high) {
        const size = Math.floor((low + high) / 2);
        context.font = `${size}px ${options.family}`;
        const lines = wrap(context, text, area.width);
        if (lines.length * size * options.leading <= area.height) {
            best = size;
            bestLines = lines;
            low = size + 1;
        } else {
            high = size - 1;
        }
    }

    context.font = `${best}px ${options.family}`;
    const lines = bestLines.length > 0 ? bestLines : wrap(context, text, area.width);
    const total = lines.length * best * options.leading;
    let y = area.y + (area.height - total) / 2 + best;
    for (const line of lines) {
        const width = context.measureText(line).width;
        context.fillText(line, area.x + (area.width - width) / 2, y);
        y += best * options.leading;
    }
}

function drawVertical(context: CanvasRenderingContext2D, box: GroupData, text: string, options: TypesetOptions, given?: string[]): void {
    const area = inner(box);
    // Vertical punctuation has its own glyphs, and a mark may not lead a column.
    const characters = [...toVertical(text)].flatMap((character) => [character]);
    let size = Math.max(8, Math.min(area.width, area.height) / 4);
    let columns: string[][] = [];

    while (size > 7) {
        context.font = `${size}px ${options.family}`;
        const perColumn = Math.max(1, Math.floor(area.height / (size * 1.1)));
        columns = [];
        let cursor = 0;
        while (cursor < characters.length) {
            const limit = Math.min(cursor + perColumn, characters.length);
            const take = cursor + safeBreak(characters, limit - cursor);
            columns.push(characters.slice(cursor, take));
            cursor = take;
        }
        if (given && given.length > 0 && given.every((column) => [...column].length <= perColumn)) {
            columns = given.map((column) => [...column]);
        }
        if (columns.length * size * 1.1 <= area.width) break;
        size -= 1;
    }

    context.font = `${size}px ${options.family}`;
    const total = columns.length * size * 1.1;
    let x = area.x + area.width - (area.width - total) / 2 - size / 2;
    for (const column of columns) {
        // A mark takes half a cell, so the column is measured with the same rule.
        const used = column.reduce((sum, character) => sum + size * squeeze(character), 0);
        let y = area.y + (area.height - used) / 2 + size;
        for (const character of column) {
            const width = context.measureText(character).width;
            context.fillText(character, x - width / 2, y);
            y += size * squeeze(character);
        }
        x -= size * 1.1;
    }
}

/** Keep the paint inside the balloon, so nothing spills over the artwork. */
export function renderTypeset(
    image: CanvasImageSource,
    width: number,
    height: number,
    groups: Paragraph[],
    ruby: { x: number; y: number; width: number; height: number }[] = [],
    options: TypesetOptions = DEFAULT_OPTIONS,
): string {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The browser refused a 2D context for the page.');

    context.drawImage(image, 0, 0, width, height);
    context.textBaseline = 'alphabetic';
    context.fillStyle = '#ffffff';

    // Grow each fill the way the target dilates its mask, so the small kana
    // sitting beside a column are cleared with the column itself.
    for (const group of groups) {
        const margin = Math.max(2, Math.min(group.box.width, group.box.height) * 0.06);
        context.save();
        clipTo(context, group);
        context.fillRect(
            group.box.x - margin,
            group.box.y - margin,
            group.box.width + margin * 2,
            group.box.height + margin * 2,
        );
        context.restore();
    }

    // Ruby that was pulled off a line keeps its own box, and it is still ink.
    for (const box of ruby) {
        context.fillRect(box.x - 1, box.y - 1, box.width + 2, box.height + 2);
    }

    context.fillStyle = '#111111';
    context.textAlign = 'left';
    for (const group of groups) {
        context.save();
        clipTo(context, group);
        if (isVertical(group.box)) drawVertical(context, group.box, group.text, options, group.columns);
        else drawHorizontal(context, group.box, group.text, options);
        context.restore();
    }

    return canvas.toDataURL('image/png');
}
