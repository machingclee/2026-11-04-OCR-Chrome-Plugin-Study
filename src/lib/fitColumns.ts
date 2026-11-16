import { canEndLine, canStartLine } from './punct';

/** Characters that are not glyphs of the column. */
function isGlyph(character: string): boolean {
    return character !== '\u2060' && character !== '\n';
}

/** Characters that take a cell of the column. */
function cellsOf(text: string): number {
    return [...text].filter(isGlyph).length;
}

const MARK_END = /[，。、！？；：,.!?;:…⋯︙]/u;

/**
 * Pieces for a translator that sent none: its columns, each cut after its
 * punctuation. These are only phrase hints, so the fit may still cut inside
 * one, at a price (see `fitColumns`).
 */
export function fallbackSegments(columns: string[]): string[] {
    const pieces: string[] = [];
    for (const column of columns) {
        let current = '';
        const characters = [...column];
        characters.forEach((character, at) => {
            current += character;
            const next = characters[at + 1] ?? '';
            if (MARK_END.test(character) && !MARK_END.test(next)) {
                pieces.push(current);
                current = '';
            }
        });
        if (current.length > 0) pieces.push(current);
    }
    return pieces;
}

export type ColumnFit = {
    /** One part per line, in the order of `capacities`. */
    parts: string[];
    /**
     * Font factor every line of the group shares so that each part fits its
     * line: 1 when everything fits at the source size, never below `minScale`.
     */
    scale: number;
};

export type FitOptions = {
    /** Smallest font factor the fit may ask for. */
    minScale?: number;
    /**
     * Cost of cutting a column inside a piece instead of between two. High
     * when the pieces are words the translator marked as unbreakable, low when
     * they are only punctuation hints.
     */
    insidePenalty?: number;
    /**
     * The translator's own split into lines. Used as it is when it has one
     * part per line, its parts are the same text, and it fits at a font factor
     * of at least `keepScale`: the translator split by meaning, the fit only
     * by room.
     */
    preferred?: string[];
    keepScale?: number;
};

function scaleFor(parts: string[], capacities: number[]): number {
    let scale = 1;
    parts.forEach((part, line) => {
        const length = cellsOf(part);
        if (length > 0 && length > capacities[line]) scale = Math.min(scale, capacities[line] / length);
    });
    return scale;
}

/**
 * Lay a translation into the lines the reader found, without inventing any.
 *
 * Line i holds `capacities[i]` glyphs at its source size. The text is cut into
 * exactly one non-empty part per line, in reading order. A cut is free between
 * two pieces, costs `insidePenalty` inside a piece, and is impossible where a
 * mark may not start or end a column. Among the legal cuts the chosen one
 * first avoids overflowing a line, then fills every line to the same share of
 * its room, so a long line takes more text than a short one and no line is
 * left nearly empty while its neighbour runs past the end of its column.
 *
 * A dynamic program over (characters used, lines filled) makes this exact for
 * the additive cost below, and the sizes involved (a few dozen characters,
 * a handful of lines) keep it instant.
 */
export function fitColumns(segments: string[], capacities: number[], options: FitOptions = {}): ColumnFit {
    const minScale = options.minScale ?? 0.6;
    const insidePenalty = options.insidePenalty ?? 4;
    const lines = capacities.length;
    const text = segments.join('');
    if (lines === 0) return { parts: [], scale: 1 };
    if (lines === 1) return { parts: [text], scale: Math.max(minScale, scaleFor([text], capacities)) };

    const preferred = options.preferred;
    if (preferred && preferred.length === lines && preferred.every((part) => cellsOf(part) > 0)
        && preferred.join('') === text) {
        const scale = scaleFor(preferred, capacities);
        if (scale >= (options.keepScale ?? 0.85)) return { parts: [...preferred], scale };
    }

    const characters = [...text];
    const count = characters.length;
    if (count < lines) {
        return { parts: characters.concat(Array.from({ length: lines - count }, () => '')), scale: 1 };
    }

    // Where each piece ends, as a character offset: a free cut.
    const free = new Set<number>();
    let offset = 0;
    for (const piece of segments) {
        offset += [...piece].length;
        free.add(offset);
    }
    const cutCost = (at: number): number => {
        if (at <= 0 || at >= count) return 0;
        if (!canEndLine(characters[at - 1]) || !canStartLine(characters[at])) return Number.POSITIVE_INFINITY;
        return free.has(at) ? 0 : insidePenalty;
    };

    const glyphs = [0];
    for (const character of characters) glyphs.push(glyphs[glyphs.length - 1] + (isGlyph(character) ? 1 : 0));
    const room = capacities.reduce((sum, value) => sum + Math.max(1, value), 0);
    const share = glyphs[count] / room;
    const lineCost = (line: number, start: number, end: number): number => {
        const ratio = (glyphs[end] - glyphs[start]) / Math.max(1, capacities[line]);
        const overflow = Math.max(0, ratio - 1);
        return overflow * overflow * 100 + (ratio - share) * (ratio - share);
    };

    // best[k][i]: lowest cost for the first i characters in the first k lines.
    const best = Array.from({ length: lines + 1 }, () => new Array<number>(count + 1).fill(Number.POSITIVE_INFINITY));
    const back = Array.from({ length: lines + 1 }, () => new Array<number>(count + 1).fill(-1));
    best[0][0] = 0;
    for (let line = 1; line <= lines; line += 1) {
        const last = line === lines;
        for (let end = line; end <= count - (lines - line); end += 1) {
            if (last && end !== count) continue;
            const cut = cutCost(end);
            if (!Number.isFinite(cut)) continue;
            for (let start = line - 1; start < end; start += 1) {
                const before = best[line - 1][start];
                if (!Number.isFinite(before) || glyphs[end] === glyphs[start]) continue;
                const cost = before + lineCost(line - 1, start, end) + cut;
                if (cost < best[line][end]) {
                    best[line][end] = cost;
                    back[line][end] = start;
                }
            }
        }
    }

    if (!Number.isFinite(best[lines][count])) {
        // Every legal cut was ruled out, which only marks can do: share the
        // characters out evenly and accept a mark at the head of a column.
        const parts: string[] = [];
        for (let line = 0; line < lines; line += 1) {
            parts.push(characters.slice(Math.round((count * line) / lines), Math.round((count * (line + 1)) / lines)).join(''));
        }
        return { parts, scale: Math.max(minScale, scaleFor(parts, capacities)) };
    }

    const cuts: number[] = [];
    let end = count;
    for (let line = lines; line >= 1; line -= 1) {
        cuts.unshift(end);
        end = back[line][end];
    }
    const parts: string[] = [];
    let start = 0;
    for (const cut of cuts) {
        parts.push(characters.slice(start, cut).join(''));
        start = cut;
    }
    return { parts, scale: Math.max(minScale, scaleFor(parts, capacities)) };
}
