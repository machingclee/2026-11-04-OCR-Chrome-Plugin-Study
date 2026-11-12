import type { GroupData } from '../shared/types';
import { canStartLine, squeeze, toVertical } from './punct';

type Paragraph = { box: GroupData; text: string; columns?: string[]; outline?: { x: number; y: number }[] };

export type TypesetOptions = {
    family: string;
    leading: number;
    weight: 'normal' | 'bold';
    minSize: number;
    maxSize: number;
};

const DEFAULT_OPTIONS: TypesetOptions = {
    family: 'system-ui, "PingFang TC", sans-serif',
    leading: 1.15,
    weight: 'normal',
    minSize: 9,
    maxSize: 26,
};

function inner(box: GroupData): { x: number; y: number; width: number; height: number } {
    const pad = Math.max(2, Math.min(box.width, box.height) * 0.06);
    return {
        x: box.x + pad,
        y: box.y + pad,
        width: Math.max(8, box.width - pad * 2),
        height: Math.max(8, box.height - pad * 2),
    };
}

/** Wrap a horizontal run into lines that fit the width. */
function wrap(context: CanvasRenderingContext2D, text: string, width: number): string[] {
    const lines: string[] = [];
    let current = '';
    for (const character of text) {
        const next = current + character;
        if (context.measureText(next).width > width && current.length > 0) {
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

/** Pick the size that fits, but never above the cap. One pass, no search. */
function fitSize(
    context: CanvasRenderingContext2D,
    text: string,
    width: number,
    height: number,
    family: string,
    max: number,
    min: number,
): { size: number; lines: string[] } {
    let size = Math.min(max, Math.max(min, Math.floor(width / 6)));
    for (; size >= min; size -= 1) {
        context.font = `${size}px ${family}`;
        const lines = wrap(context, text, width);
        if (lines.length * size * 1.2 <= height) return { size, lines };
    }
    context.font = `${min}px ${family}`;
    return { size: min, lines: wrap(context, text, width) };
}

function drawHorizontal(
    context: CanvasRenderingContext2D,
    box: GroupData,
    text: string,
    options: TypesetOptions,
): void {
    const area = inner(box);
    const { size, lines } = fitSize(context, text, area.width, area.height, options.family, options.maxSize, options.minSize);
    context.font = `${options.weight} ${size}px ${options.family}`;
    let y = area.y + (area.height - lines.length * size * options.leading) / 2 + size;
    for (const line of lines) {
        const width = context.measureText(line).width;
        context.fillText(line, area.x + (area.width - width) / 2, y);
        y += size * options.leading;
    }
}

function drawVertical(
    context: CanvasRenderingContext2D,
    box: GroupData,
    text: string,
    options: TypesetOptions,
): void {
    const area = inner(box);
    const characters = [...toVertical(text)];
    let size = Math.min(options.maxSize, Math.max(options.minSize, Math.floor(area.width / 2)));
    for (; size >= options.minSize; size -= 1) {
        const perColumn = Math.max(1, Math.floor(area.height / (size * options.leading)));
        const columns = Math.ceil(characters.length / perColumn);
        if (columns * size * 1.2 <= area.width) break;
    }
    const perColumn = Math.max(1, Math.floor(area.height / (size * options.leading)));
    const chunks: string[][] = [];
    for (let index = 0; index < characters.length; index += perColumn) {
        chunks.push(characters.slice(index, index + perColumn));
    }
    context.font = `${options.weight} ${size}px ${options.family}`;
    let x = area.x + area.width - size / 2;
    for (const chunk of chunks) {
        const used = chunk.reduce((sum, character) => sum + size * squeeze(character), 0);
        let y = area.y + (area.height - used) / 2 + size;
        for (const character of chunk) {
            const width = context.measureText(character).width;
            context.fillText(character, x - width / 2, y);
            y += size * squeeze(character);
        }
        x -= size * 1.2;
    }
}

/**
 * Paint the page: clear each group, then letter it. The size is capped, so a bad
 * box can never turn one syllable into a headline again.
 */
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
    context.fillStyle = '#ffffff';
    context.textBaseline = 'alphabetic';
    context.textAlign = 'left';

    for (const group of groups) {
        context.fillRect(group.box.x, group.box.y, group.box.width, group.box.height);
    }
    for (const box of ruby) {
        context.fillRect(box.x - 1, box.y - 1, box.width + 2, box.height + 2);
    }

    context.fillStyle = '#111111';
    for (const group of groups) {
        if (group.box.height > group.box.width * 1.3) drawVertical(context, group.box, group.text, options);
        else drawHorizontal(context, group.box, group.text, options);
    }

    return canvas.toDataURL('image/png');
}
