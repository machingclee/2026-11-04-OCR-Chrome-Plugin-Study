import type { GroupData } from '../shared/types';

type Paragraph = { box: GroupData; text: string };

function isVertical(box: { width: number; height: number }): boolean {
    return box.height > box.width * 1.3;
}

/** Break a string into lines that fit the width of the box. */
function wrap(context: CanvasRenderingContext2D, text: string, width: number): string[] {
    const lines: string[] = [];
    let current = '';
    for (const character of text) {
        const next = current + character;
        if (context.measureText(next).width > width && current.length > 0) {
            lines.push(current);
            current = character;
        } else {
            current = next;
        }
    }
    if (current.length > 0) lines.push(current);
    return lines;
}

function drawHorizontal(context: CanvasRenderingContext2D, box: GroupData, text: string): void {
    const padding = Math.max(2, Math.min(box.width, box.height) * 0.08);
    const width = box.width - padding * 2;
    let size = Math.min(box.width, box.height * 0.9);
    let lines: string[] = [];

    while (size > 7) {
        context.font = `${size}px system-ui, sans-serif`;
        lines = wrap(context, text, width);
        if (lines.length * size * 1.15 <= box.height - padding * 2) break;
        size -= 1;
    }

    context.font = `${size}px system-ui, sans-serif`;
    const total = lines.length * size * 1.15;
    let y = box.y + (box.height - total) / 2 + size;
    for (const line of lines) {
        const lineWidth = context.measureText(line).width;
        context.fillText(line, box.x + (box.width - lineWidth) / 2, y);
        y += size * 1.15;
    }
}

function drawVertical(context: CanvasRenderingContext2D, box: GroupData, text: string): void {
    const padding = Math.max(2, Math.min(box.width, box.height) * 0.08);
    const height = box.height - padding * 2;
    let size = Math.min(box.width * 0.85, height);
    let columns: string[][] = [];

    while (size > 7) {
        context.font = `${size}px system-ui, sans-serif`;
        const perColumn = Math.max(1, Math.floor(height / size));
        columns = [];
        const characters = [...text];
        for (let index = 0; index < characters.length; index += perColumn) {
            columns.push(characters.slice(index, index + perColumn));
        }
        if (columns.length * size * 1.1 <= box.width - padding * 2) break;
        size -= 1;
    }

    context.font = `${size}px system-ui, sans-serif`;
    const total = columns.length * size * 1.1;
    let x = box.x + box.width - (box.width - total) / 2 - size / 2;
    for (const column of columns) {
        let y = box.y + padding + size;
        for (const character of column) {
            const width = context.measureText(character).width;
            context.fillText(character, x - width / 2, y);
            y += size * 1.1;
        }
        x -= size * 1.1;
    }
}

/**
 * Paint the translation over the page and hand back a data url, so the page can
 * show the finished image instead of an overlay.
 */
export function renderTypeset(
    image: CanvasImageSource,
    width: number,
    height: number,
    groups: Paragraph[],
    ruby: { x: number; y: number; width: number; height: number }[] = [],
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
        const margin = Math.max(2, Math.min(group.box.width, group.box.height) * 0.12);
        context.fillRect(
            group.box.x - margin,
            group.box.y - margin,
            group.box.width + margin * 2,
            group.box.height + margin * 2,
        );
    }

    // Ruby that was pulled off a line keeps its own box, and it is still ink.
    for (const box of ruby) {
        context.fillRect(box.x - 1, box.y - 1, box.width + 2, box.height + 2);
    }

    context.fillStyle = '#111111';
    context.textAlign = 'left';
    for (const group of groups) {
        if (isVertical(group.box)) drawVertical(context, group.box, group.text);
        else drawHorizontal(context, group.box, group.text);
    }

    return canvas.toDataURL('image/png');
}
