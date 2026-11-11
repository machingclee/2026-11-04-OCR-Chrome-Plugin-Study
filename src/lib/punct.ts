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

export function toVertical(text: string): string {
    return [...text].map((character) => H2V.get(character) ?? character).join('');
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
