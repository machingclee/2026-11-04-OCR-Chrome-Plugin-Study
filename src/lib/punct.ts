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
    // U+22EE sits on the left of its em box. The vertical presentation form
    // is fullwidth, so the dots share the column centre with the kanji.
    ['…', '︙'],
    ['⋯', '︙'],
    ['⋮', '︙'],
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
    // Upright vertical text does not rotate a dash, so a horizontal bar sits
    // beside the column. The vertical em dash is already drawn top to bottom.
    ['—', '︱'],
    ['–', '︱'],
    ['―', '︱'],
    ['−', '︱'],
    ['－', '︱'],
    ['ー', '︱'],
    ['ｰ', '︱'],
    ['─', '︱'],
    // A wave dash is drawn across in horizontal text and down the column in
    // vertical text. U+2240 is the vertical squiggle; leaving ～ upright put a
    // horizontal tilde in the middle of a vertical label.
    ['～', '≀'],
    ['〜', '≀'],
    ['~', '≀'],
    ['〰', '≀'],
]);

/**
 * One mark for a run of exclamation and question marks, the way a Japanese
 * page sets it: ！？ is one glyph, not two.
 *
 * Two full-width marks in a vertical column take two cells and read as two
 * beats, so the translation drew "！？" down the column where the source had a
 * single ⁉. The composed forms are one character, one cell and one mark.
 */
export function normalizeMarks(text: string): string {
    return text
        // ⁉ first: "！？" and "?!" both name surprise, not two questions.
        .replace(/[!！]\s*[?？]/gu, '⁉')
        .replace(/[?？]\s*[!！]/gu, '⁈')
        .replace(/[?？]{2,}/gu, '⁇');
}

export function toHorizontal(text: string): string {
    // Chinese and Japanese horizontal text uses two ellipsis marks, not three
    // ASCII periods. Keep a single period because it may be a decimal point.
    return normalizeMarks(text)
        .replace(/(?:[.．・·]\s*){2,}/g, '……')
        .replace(/…+/g, '……')
        .replace(/⋯+/g, '……');
}

export function toVertical(text: string): string {
    // Three ASCII dots or a run of ellipsis marks is one vertical ellipsis, not
    // three full stops or a horizontal row of dots beside the column.
    const collapsed = normalizeMarks(text)
        .replace(/(?:[.．・·]\s*){2,}/g, '︙')
        .replace(/…+/g, '︙')
        .replace(/⋯+/g, '︙')
        .replace(/⋮+/g, '︙');
    return [...collapsed]
        .map((character) => H2V.get(character) ?? character)
        .join('')
        // Keep the ellipsis with the preceding glyph. The label may use several
        // columns, but a column must not begin with a lone ellipsis.
        .replace(/(.)([⋮︙︱])/gu, '$1\u2060$2');
}

/** A mark that may not start a line, which is where a break is forbidden. */
const NO_START = new Set([
    '。', '，', '、', '！', '？', '；', '：', '!', '?', '⁉', '⁈', '⁇', '︕', '︖', '︒', '︐', '︔', '︓',
    ')', '）', '」', '』', '】', '〕', '︶', '﹂', '﹄', '⋮', '︙', '︱', '…', '⋯',
]);

/** A mark that may not end a line. */
const NO_END = new Set(['(', '（', '「', '『', '【', '〔', '︵', '﹁', '﹃']);

const STRONG = new Set(['。', '！', '？', '!', '?', '⁉', '⁈', '⁇', '；', ';', '︕', '︖', '︒']);
const SOFT = new Set(['，', '、', ',', '：', ':', '…', '⋮', '︙', '︐', '︔', '︓']);
const PHRASE_END = new Set([...STRONG, ...SOFT]);

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

/** Whether a mark may close a column; an opening bracket may not. */
export function canEndLine(character: string): boolean {
    return !NO_END.has(character);
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

/**
 * Split a run into parts by weight, keeping each part near its share.
 *
 * The renderer wraps a column that holds more text than its box, which turns
 * one label into two visible columns. So the split follows the weights closely
 * and only nudges a boundary by a character or two to avoid starting a part
 * with a mark that may not begin a line.
 */
export function splitByWeight(characters: string[], weights: number[], preferred: number[] = []): string[] {
    const total = weights.reduce((sum, weight) => sum + Math.max(1, weight), 0);
    // A cut at a phrase boundary the translator chose, or right after a mark,
    // keeps a word such as 外星人 in one column. It may move the share by up to
    // two characters; past that the weights win.
    const phraseBreaks = new Set(preferred);
    characters.forEach((character, index) => {
        const next = characters[index + 1] ?? '';
        if (PHRASE_END.has(character) && !NO_START.has(next) && !PHRASE_END.has(next)) phraseBreaks.add(index + 1);
    });
    const parts: string[] = [];
    let cursor = 0;
    let counted = 0;
    weights.forEach((weight, index) => {
        const left = characters.length - cursor;
        if (left <= 0) {
            parts.push('');
            return;
        }
        if (index === weights.length - 1) {
            parts.push(characters.slice(cursor).join(''));
            cursor = characters.length;
            return;
        }
        counted += Math.max(1, weight);
        const boundary = Math.round((characters.length * counted) / total);
        let cut = Math.max(1, Math.min(left, boundary - cursor));
        // Leave at least one character for every part still to come.
        const room = left - (weights.length - 1 - index);
        let snapped = -1;
        for (let shift = 0; shift <= 2 && snapped < 0; shift += 1) {
            for (const candidate of shift === 0 ? [cut] : [cut - shift, cut + shift]) {
                if (candidate >= 1 && candidate <= room && phraseBreaks.has(cursor + candidate)) {
                    snapped = candidate;
                    break;
                }
            }
        }
        if (snapped > 0) {
            parts.push(characters.slice(cursor, cursor + snapped).join(''));
            cursor += snapped;
            return;
        }
        for (let step = 0; step < 2 && cut > 1; step += 1) {
            const previous = characters[cursor + cut - 1];
            const next = characters[cursor + cut];
            if (!NO_END.has(previous) && !NO_START.has(next)) break;
            cut -= 1;
        }
        parts.push(characters.slice(cursor, cursor + cut).join(''));
        cursor += cut;
    });
    return parts;
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
