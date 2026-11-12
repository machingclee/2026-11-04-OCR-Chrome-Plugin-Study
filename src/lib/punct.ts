/**
 * Vertical text needs its own punctuation. The halfwidth forms rotate badly, so
 * each mark is swapped for the full-width vertical presentation form, which the
 * font already draws the right way up.
 */
const H2V = new Map<string, string>([
    ['!', '︕'],
    ['?', '︖'],
    ['.', '︒'],
    ['。', '︒'],
    [',', '︐'],
    ['，', '︐'],
    [';', '︔'],
    ['；', '︔'],
    [':', '︓'],
    ['：', '︓'],
    ['…', '⋮'],
    ['⋯', '︙'],
    ['(', '︵'],
    [')', '︶'],
    ['（', '︵'],
    ['）', '︶'],
    ['「', '﹁'],
    ['」', '﹂'],
    ['『', '﹃'],
    ['』', '﹄'],
    ['[', '﹇'],
    [']', '﹈'],
]);

export function toHorizontal(text: string): string {
    // Chinese and Japanese horizontal text uses two ellipsis marks, not three
    // ASCII periods. Keep a single period because it may be a decimal point.
    return text
        .replace(/(?:[.．・·]\s*){2,}/g, '……')
        .replace(/…+/g, '……')
        .replace(/⋯+/g, '……');
}

export function toVertical(text: string): string {
    // Three ASCII dots or a run of ellipsis marks is one vertical ellipsis, not
    // three full stops or a horizontal row of dots beside the column.
    const collapsed = text
        .replace(/(?:[.．・·]\s*){2,}/g, '⋮')
        .replace(/…+/g, '⋮')
        .replace(/⋯+/g, '⋮');
    return [...collapsed].map((character) => H2V.get(character) ?? character).join('');
}

/** A mark that may not start a line, which is where a break is forbidden. */
const NO_START = new Set([
    '。', '，', '、', '！', '？', '；', '：', '!', '?', '︕', '︖', '︒', '︐', '︔', '︓',
    ')', '）', '」', '』', '】', '〕', '︶', '﹂', '﹄', '⋮', '︙',
]);

/** A mark that may not end a line. */
const NO_END = new Set(['(', '（', '「', '『', '【', '〔', '︵', '﹁', '﹃']);

const STRONG = new Set(['。', '！', '？', '!', '?', '；', ';', '︕', '︖', '︒']);
const SOFT = new Set(['，', '、', ',', '：', ':', '…', '⋮', '︙', '︐', '︔', '︓']);

function score(character: string): number {
    if (STRONG.has(character)) return 3;
    if (SOFT.has(character)) return 2;
    return 0;
}

/**
 * Choose where to break. A break after a full stop reads better than a break in
 * the middle of a word, and a break before a closing mark is never allowed.
 */
export function bestBreak(characters: string[], limit: number): number {
    let best = -1;
    let bestScore = 0;
    for (let index = 1; index <= limit && index < characters.length; index += 1) {
        const previous = characters[index - 1];
        const next = characters[index];
        if (NO_END.has(previous) || NO_START.has(next)) continue;
        const value = score(previous);
        if (value > bestScore) {
            bestScore = value;
            best = index;
        }
    }
    return bestScore > 0 ? best : -1;
}

/** Whether a mark may lead a column at all. */
export function canStartLine(character: string): boolean {
    return !NO_START.has(character);
}

/**
 * The site of a break, preferring punctuation. When the limit lands inside a
 * mark, or right before one, it walks back until the break is legal, so "?!"
 * and "……" always stay together.
 */
export function safeBreak(characters: string[], limit: number): number {
    const preferred = bestBreak(characters, limit);
    if (preferred > 0) return preferred;

    let cut = Math.min(limit, characters.length);
    while (cut > 1) {
        const previous = characters[cut - 1];
        const next = characters[cut];
        if (!NO_END.has(previous) && !NO_START.has(next)) return cut;
        cut -= 1;
    }
    return Math.max(1, cut);
}

/** Group runs of marks so a split can never fall inside "?!". */
export function toUnits(text: string): string[] {
    const units: string[] = [];
    for (const character of text) {
        const last = units[units.length - 1];
        if (last && STRONG.has(last[0]) && (STRONG.has(character) || SOFT.has(character))) {
            units[units.length - 1] = last + character;
            continue;
        }
        units.push(character);
    }
    return units;
}

/**
 * Marks that sit in a half cell, the way a Japanese page sets them. The glyph
 * keeps its size, but the advance shrinks, so a run of commas does not open a
 * gap down the column.
 */
const HALF_CELL = new Set(['、', '。', '，', '．', '︑', '︒', '︐', ',', '.']);

export function squeeze(character: string): number {
    return HALF_CELL.has(character) ? 0.62 : 1.1;
}
