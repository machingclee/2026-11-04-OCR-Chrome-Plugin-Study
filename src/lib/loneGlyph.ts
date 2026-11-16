import type { RegionAnswer } from './translatePrompt';

/**
 * What a lone glyph is, and why it is not translated like a sentence.
 *
 * A comic balloon sometimes holds one character and nothing else: a name
 * (円, read つぶら, printed with its reading beside it), a unit, a label. The
 * translator, asked to write natural Chinese, turns that single character into
 * a phrase — 円 became 日圓 and then 是錢的意思 — and the balloon that holds
 * one character ends up with a sentence crammed into it. The prompt says what
 * to do; this module makes it hold, whatever the model answers.
 */

/** Marks that sit in a column without being the word. */
const ORNAMENT = /[\s\u2060\u3000。、，．,.!?！？…‥⋯︙・「」『』（）()［］\[\]〈〉《》【】〔〕｛｝{}"'“”‘’〜～]/u;

/** Kana: a lone kana is dialogue (「え？」), not a name. */
const KANA = /[\u3040-\u309F\u30A0-\u30FF\u30FC\u30FB]/u;

/** The characters of `text` that carry the word, with the marks removed. */
export function spokenGlyphs(text: string): string[] {
    return [...text].filter((character) => !ORNAMENT.test(character));
}

/** True when the region is one kanji or symbol, never a kana. */
export function isLoneGlyph(text: string): boolean {
    const glyphs = spokenGlyphs(text);
    if (glyphs.length !== 1) return false;
    return !KANA.test(glyphs[0]);
}

/**
 * A Japanese honorific is not part of the name: 伯爵様 came back as 伯爵様 on a
 * measured run, a Japanese glyph in a Chinese label. 様 is the one that shows up
 * in a name box, and 大人 is what the Chinese edition prints.
 */
function withChineseHonorific(text: string): string {
    return text.replace(/様$/u, '大人');
}

/** The name a reader labelled `type: "name"`, with notes the model added. */
function withoutNotes(text: string): string {
    return text
        // 有留木 環（Arutoki Wataru） kept only the name.
        .replace(/[（(][^）)]{0,40}[）)]/gu, '')
        .trim();
}

/**
 * A single glyph stays a single glyph.
 *
 * The model may return 圓, which is the same name in Traditional Chinese, so an
 * answer that is one character is kept. Anything longer — 日圓, 是錢 — is not
 * this balloon's text, and the source character stands in.
 */
function keepSingleGlyph(source: string, answer: RegionAnswer): RegionAnswer {
    const glyphs = spokenGlyphs(source);
    if (glyphs.length !== 1) return answer;
    if (spokenGlyphs(answer.text).length === 1) return answer;
    const glyph = glyphs[0];
    return {
        ...answer,
        text: glyph,
        columns: [glyph],
        segments: [glyph],
        type: 'name',
        skip: undefined,
    };
}

/**
 * A name is written as the name. A translation that grew a word, an
 * explanation or a note beside it is not the label any more, so the source
 * name stands in instead of a sentence in a name plate.
 */
function keepName(source: string, answer: RegionAnswer): RegionAnswer {
    if (answer.type !== 'name') return answer;
    const sourceGlyphs = spokenGlyphs(source).length;
    if (sourceGlyphs === 0) return answer;
    const notes = withoutNotes(answer.text);
    // The length is the model's own, before the honorific swap: 伯爵様 becomes
    // 伯爵大人, which is one glyph longer and is still the same two-glyph name.
    const glyphs = spokenGlyphs(notes);
    if (glyphs.length === 0) return { ...answer, text: source.trim() };
    if (glyphs.length > sourceGlyphs) {
        return {
            ...answer,
            text: source.trim(),
            columns: undefined,
            segments: undefined,
        };
    }
    const text = withChineseHonorific(notes);
    if (text !== answer.text) {
        return { ...answer, text, columns: columnsOf(text, answer.columns), segments: undefined };
    }
    return answer;
}

/** The model's own columns, when they still describe the trimmed text. */
function columnsOf(text: string, columns: string[] | undefined): string[] | undefined {
    if (!columns || columns.length === 0) return undefined;
    const joined = columns.join('').replace(/\s/gu, '');
    return joined === text.replace(/\s/gu, '') ? columns : undefined;
}

/**
 * The answer for one region, with the lone-glyph and name rules applied. Every
 * path that writes a translation goes through here, so a balloon that holds one
 * character can never end up holding a sentence.
 */
export function preserveLoneName(source: string, answer: RegionAnswer): RegionAnswer {
    // A sound effect keeps its ink, and an answer the model skipped is not a
    // translation to repair: writing the glyph in would translate artwork.
    if (answer.skip === true || answer.type === 'sfx') return answer;
    const single = keepSingleGlyph(source, answer);
    const named = keepName(source, single);
    // The honorific swap goes last, after the length rules: 伯爵様 is a two-glyph
    // name and 伯爵大人 is that same name, so converting first made it look a
    // glyph too long and the source stood in. It also applies whatever type the
    // reader gave, because 伯爵様 came back as a `chat` region on one run.
    const honorific = withChineseHonorific(named.text);
    return honorific === named.text
        ? named
        : { ...named, text: honorific, columns: columnsOf(honorific, named.columns) };
}
