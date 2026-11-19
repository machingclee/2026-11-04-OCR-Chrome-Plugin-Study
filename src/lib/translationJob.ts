import { DEFAULT_REASONING_EFFORT } from '../shared/constants';
import type { ReasoningEffort, TranslatorChoice } from '../shared/constants';
import type { BoxData, BubbleData, GroupData, OverlayItem } from '../shared/types';
import type { RegionAnswer } from './translatePrompt';
import { translateWithDeepSeek } from './translateDeepSeek';
import { normalizeMarks, toHorizontal, toVertical } from './punct';
import { fallbackSegments, fitColumns } from './fitColumns';
import { isLoneGlyph, preserveLoneName } from './loneGlyph';

export type TranslationSettings = {
    translator: TranslatorChoice;
    deepSeekKey: string;
    /** How long DeepSeek may think. Omitted means the default level. */
    effort?: ReasoningEffort;
};

export type TranslationJobInput = {
    groups: GroupData[];
    boxes: BoxData[];
    balloons: BubbleData[];
    imageWidth: number;
    imageHeight: number;
    settings: TranslationSettings;
    signal?: AbortSignal;
};

export type EraseBox = { x: number; y: number; width: number; height: number; angle?: number };

export type TranslationJobResult = {
    items: OverlayItem[];
    answers: RegionAnswer[];
    used: string;
    active: TranslatorChoice;
    skipped: number;
    withBalloon: number;
    /** Every source line of a translated group, including columns that received no label. */
    erase: EraseBox[];
    /**
     * Source lines that got no translation. Their ink stays: erasing text the
     * translator left out would leave a blank hole in the balloon.
     */
    keep: EraseBox[];
    /**
     * Area of every group that actually received a label. The inpaint pass is
     * gated on this, not on the reader's regions: a block whose translation
     * failed must keep its ink, or the balloon is left blank.
     */
    labelled: EraseBox[];
};

function countWithBalloon(list: GroupData[], balloons: BubbleData[]): number {
    return list.filter((group) => {
        const centreX = group.x + group.width / 2;
        const centreY = group.y + group.height / 2;
        return balloons.some((bubble) =>
            centreX >= bubble.x && centreX <= bubble.x + bubble.width
            && centreY >= bubble.y && centreY <= bubble.y + bubble.height);
    }).length;
}

/**
 * Upright crop of a leaned line, placed so a rotation around its centre lands on
 * the glyphs. The direction of the text decides which side is the thickness; the
 * shape of the page box cannot, because a line leaning 20 degrees has a box that
 * can be taller than it is wide.
 */
function placedFrame(line: BoxData): { x: number; y: number; width: number; height: number; angle?: number } {
    const angle = line.angle ?? 0;
    if (Math.abs(angle) < 0.01) {
        return { x: line.x, y: line.y, width: line.width, height: line.height };
    }
    const length = line.lineLength && line.lineLength >= 4 ? line.lineLength : Math.max(line.width, line.height);
    // The ink rectangle under-reads a leaned column (11.6px on a 28px glyph),
    // so the frame was 12px wide while the label was set at 28px. The advance
    // is the second measurement, the same one the font uses.
    const glyphs = Math.max(1, [...line.text.replace(/[\s\u2060]/gu, '')].length);
    const advance = (line.lineLength ?? 0) >= 8 ? (line.lineLength as number) / glyphs * 0.85 : 0;
    const thickness = Math.max(
        line.lineThickness && line.lineThickness >= 4 ? line.lineThickness : Math.min(line.width, line.height),
        advance,
    );
    const vertical = line.direction === 'vertical';
    const size = vertical
        ? { width: thickness, height: length }
        : { width: length, height: thickness };
    const centreX = line.x + line.width / 2;
    const centreY = line.y + line.height / 2;
    return {
        x: centreX - size.width / 2,
        y: centreY - size.height / 2,
        width: size.width,
        height: size.height,
        angle,
    };
}

/**
 * Drop a clause the model repeated at the end of its own translation.
 *
 * A translated block came back as 也就是說人類遇見外星人這件事也就是說人類: the
 * opening clause written again after the full sentence, so the page carried
 * the phrase twice in two columns. Nothing legitimate repeats its own opening
 * verbatim, so a suffix that equals the prefix is a repeat and is removed.
 */
function trimRepeatedHead(text: string): string {
    const chars = [...text];
    for (let size = Math.floor(chars.length / 2); size >= 4; size -= 1) {
        if (chars.slice(chars.length - size).join('') === chars.slice(0, size).join('')) {
            return chars.slice(0, chars.length - size).join('');
        }
    }
    return text;
}

/** Detect, filter, translate, and lay out one image without touching the page. */
export async function translateGroups(input: TranslationJobInput): Promise<TranslationJobResult> {
    const current = input.groups;
    const { settings, boxes, balloons, imageWidth, imageHeight } = input;

    if (input.signal?.aborted) throw new Error('Cancelled.');
    if (current.length === 0) throw new Error('No text was found on this page.');

    const regions = current.map((group, index) => {
        const glosses = group.glosses && group.glosses.some((value) => typeof value === 'string' && value.trim().length > 0)
            ? group.lines.map((_, at) => group.glosses?.[at]?.trim() || undefined)
            : undefined;
        return {
            id: `r${index + 1}`,
            direction: (group.vertical ?? (group.height > group.width * 1.3) ? 'v' : 'h') as 'v' | 'h',
            lines: group.lines,
            ...(glosses ? { glosses } : {}),
        };
    });

    const active = 'deepseek' as const;
    const key = settings.deepSeekKey.trim();
    // Reading and translating are two passes now. The reader answers with text
    // and layout only, at no thinking; this pass translates one block at a
    // time, at the effort the popup chose, with the rest of the page as
    // context so the speech still reads as one conversation.
    const translations = current.map((group) => (Array.isArray(group.translations)
        ? group.translations.map((text) => normalizeMarks(text.trim())).filter(Boolean).join('')
        : ''));
    const missing = translations
        .map((text, index) => (text.trim().length === 0 ? index : -1))
        .filter((index) => index >= 0);
    let used = 'DeepSeek (reading call)';
    let out: RegionAnswer[];
    if (missing.length === 0) {
        out = translations.map((text) => ({ text }));
        console.info(`[translate] ${current.length} block(s) already translated; no second request`);
    } else {
        if (key.length === 0) throw new Error('Paste a DeepSeek API key to translate this page.');
        const effort = settings.effort ?? DEFAULT_REASONING_EFFORT;
        const pageTexts = current.map((group) => group.lines.join(''));
        const answers = new Map<number, RegionAnswer>();
        const request = async (index: number): Promise<void> => {
            try {
                const [answer] = await translateWithDeepSeek(
                    [regions[index]],
                    key,
                    input.signal,
                    effort,
                    pageTexts.filter((_, other) => other !== index),
                );
                if (answer) answers.set(index, answer);
            } catch (cause) {
                if (input.signal?.aborted) return;
                console.warn(`Block ${index + 1} could not be translated.`, cause);
            }
        };
        const queue = [...missing];
        let cursor = 0;
        const worker = async (): Promise<void> => {
            while (true) {
                const at = cursor;
                cursor += 1;
                if (at >= queue.length) return;
                await request(queue[at]);
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker()));
        console.info(`[translate] ${answers.size} of ${missing.length} block(s) translated, effort ${effort}`);
        // A block that already carried a translation keeps it. Only the missing
        // ones were requested, so building the answer list from `answers` alone
        // dropped every block the reading call had translated.
        out = current.map((_, index) => {
            const ready = translations[index].trim();
            if (ready.length > 0) return { text: ready };
            return answers.get(index) ?? { text: '' };
        });
        used = 'DeepSeek (one request per block)';
    }

    // A balloon that holds one character is a name or a symbol, and its answer
    // must stay that one character. The prompt asks for it; this makes it hold
    // when the model writes a phrase anyway, on both the path that used the
    // translated text and the path that asked for it here.
    const sources = current.map((group) => group.lines.join('').trim());
    out = out.map((answer, index) => preserveLoneName(sources[index], answer));

    // Write the answers back into the block results, so the block carries the
    // translation it produced and a later pass does not translate it twice.
    current.forEach((group, index) => {
        const answer = out[index];
        if (!answer || answer.skip || answer.type === 'sfx') return;
        const columns = (answer.columns ?? []).map((column) => column.trim()).filter(Boolean);
        const text = answer.text.trim();
        if (columns.length > 0) group.translations = columns;
        else if (text.length > 0) group.translations = [text];
    });

    const items: OverlayItem[] = [];
    const erase: EraseBox[] = [];
    const keep: EraseBox[] = [];
    const labelled: EraseBox[] = [];
    let skipped = 0;
    const inkOf = (line: BoxData): EraseBox => ({ x: line.x, y: line.y, width: line.width, height: line.height });
    const linesOf = (group: GroupData): BoxData[] => boxes.filter((line) => {
        const x = line.x + line.width / 2;
        const y = line.y + line.height / 2;
        return line.text.trim().length > 0
            && x >= group.x && x <= group.x + group.width
            && y >= group.y && y <= group.y + group.height;
    });

    current.forEach((group, index) => {
        const answer = out[index];
        if (answer?.skip || answer?.type === 'sfx') {
            skipped += 1;
            console.info(`[typeset] group ${index}: the translator said ${answer.skip ? 'skip' : 'sfx'}; its ink stays`);
            if (answer?.skip) for (const line of linesOf(group)) if (line.kind !== 'sfx') keep.push(inkOf(line));
            return;
        }
        // Never stand the source text in for a translation. A missing answer
        // used to redraw the Japanese, which looked like a silent no-op.
        const text = answer?.text ?? '';
        if (text.trim().length === 0) {
            skipped += 1;
            console.warn(`[typeset] group ${index}: no translation came back; its ink stays`);
            for (const line of linesOf(group)) if (line.kind !== 'sfx') keep.push(inkOf(line));
            return;
        }

        const centreX = group.x + group.width / 2;
        const centreY = group.y + group.height / 2;
        const balloon = group.balloon
            ? balloons.find((bubble) =>
                centreX >= bubble.x && centreX <= bubble.x + bubble.width
                && centreY >= bubble.y && centreY <= bubble.y + bubble.height)
            : undefined;
        // A sound effect inside a reader block (コホン at the top of a speech)
        // has no translation of its own; it must not take one of the speech's
        // columns. Its ink is kept by the erase gate.
        const linesInGroup = linesOf(group).filter((line) => line.kind !== 'sfx');
        const verticalLines = linesInGroup.filter((line) => line.direction === 'vertical').length;
        const horizontalLines = linesInGroup.filter((line) => line.direction === 'horizontal').length;
        const vertical = verticalLines !== horizontalLines
            ? verticalLines > horizontalLines
            : balloon
                ? balloon.height > balloon.width * 1.15 || group.vertical === true
                : group.vertical ?? group.height > group.width * 1.3;
        const sortedLines = [...linesInGroup].sort((left, right) => vertical
            ? (right.x + right.width / 2) - (left.x + left.width / 2)
            : (left.y + left.height / 2) - (right.y + right.height / 2));
        const strokeOf = (line: { width: number; height: number; lineLength?: number; lineThickness?: number }) => {
            if (line.lineLength && line.lineThickness && line.lineLength > 0 && line.lineThickness > 0) {
                return Math.min(line.lineLength, line.lineThickness);
            }
            return vertical ? line.width : line.height;
        };
        const strokes = sortedLines.map(strokeOf).filter((size) => size >= 4);
        const thickest = strokes.length > 0 ? Math.max(...strokes) : 0;
        // The page-aligned width of a slanted line includes the lean, so a
        // reading looks as wide as the column. The stroke thickness does not.
        //
        // A group the reader built has one line per column, and none of those is
        // a sliver of a detection: every line is a column, so a column that came
        // back thinner than its neighbour is still a column and keeps its box.
        // The filter only applies to a group the detector shaped.
        const fromReader = sortedLines.some((line) => line.kind === 'chat' || line.kind === 'sfx');
        const bodyLines = fromReader
            ? sortedLines
            : thickest > 0
                ? sortedLines.filter((line) => strokeOf(line) >= thickest / 1.6)
                : sortedLines;
        const placedLines = bodyLines.length > 0 ? bodyLines : sortedLines;
        const frameOf = (line: BoxData) => {
            // A detector box can start above the glyphs and run out of the
            // block. The part that was cut back to the block is where the
            // column is drawn; the uncut box is what put the translation
            // outside the balloon.
            if (line.slot?.insideBlock) {
                return {
                    x: line.slot.x,
                    y: line.slot.y,
                    width: line.slot.width,
                    height: line.slot.height,
                    ...(Math.abs(line.angle ?? 0) >= 0.01 ? { angle: line.angle } : {}),
                };
            }
            const ink = placedFrame(line);
            if (!line.slot || Math.abs(line.angle ?? 0) >= 0.01) return ink;
            // The reader's box is snapped to its cell grid and can land a cell or
            // two off the glyphs: 円 came back at cell 3 of a balloon whose glyph
            // starts at cell 0, so the label was placed beside the character it
            // replaced. When the box is further from the ink than its own size,
            // the cell box was a bad estimate and the ink is where the ink is.
            const drift = Math.max(
                Math.abs((line.slot.x + line.slot.width / 2) - (ink.x + ink.width / 2)),
                Math.abs((line.slot.y + line.slot.height / 2) - (ink.y + ink.height / 2)),
            );
            return drift > Math.min(line.slot.width, line.slot.height) ? ink : line.slot;
        };
        // A group can come back with fewer columns than it had. The spare source
        // line would otherwise keep its ink, because only labelled frames are erased.
        //
        // Both frames are erased: the ink box, which is tight around the strokes,
        // and the frame the label is drawn on. They differ by a cell when the
        // reader's box is off, and a glyph edge outside the ink box but under the
        // label is exactly the そうだ that stayed on the balloon beside its
        // translation. What the label covers must be what the erase covered.
        for (const line of linesInGroup) {
            erase.push(placedFrame(line));
            const label = frameOf(line);
            if (label.x !== line.x || label.y !== line.y || label.width !== line.width || label.height !== line.height) {
                erase.push(label);
            }
        }
        // A balloon whose text is one character holds nothing else that is text:
        // the kana printed beside it is that character's reading (つぶら beside
        // 円), not a line of its own, and the reader does not report it. Clearing
        // the whole balloon takes that reading with the character; without it a
        // smear of the reading stayed beside the translation inside the balloon.
        if (balloon && isLoneGlyph(group.lines.join(''))) {
            erase.push({ x: balloon.x, y: balloon.y, width: balloon.width, height: balloon.height });
        }

        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (const line of placedLines) {
            minX = Math.min(minX, line.x);
            minY = Math.min(minY, line.y);
            maxX = Math.max(maxX, line.x + line.width);
            maxY = Math.max(maxY, line.y + line.height);
        }
        const tight = Number.isFinite(minX) && maxX > minX && maxY > minY
            ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
            : { x: group.x, y: group.y, width: group.width, height: group.height };

        // The advance of a leaned column is its length divided by its glyphs.
        // The detector's rectangle is fitted to the ink, and the ink of a
        // leaned column is sparse: あの伝説の… measured 11.6px across on a 28px
        // column, so the label was drawn at 12. The advance is a second
        // measurement; the larger of the two is the glyph.
        const glyphCount = (line: BoxData): number => Math.max(1, [...line.text.replace(/[\s\u2060]/gu, '')].length);
        const emOf = (line: BoxData): number => {
            const thickness = strokeOf(line);
            if (Math.abs(line.angle ?? 0) >= 0.01 && line.lineLength && line.lineLength >= 8) {
                return Math.max(thickness, (line.lineLength / glyphCount(line)) * 0.85);
            }
            return thickness;
        };
        const glyphSizes = placedLines
            .map((line) => {
                if (Math.abs(line.angle ?? 0) >= 0.01 && line.lineThickness && line.lineThickness >= 4) {
                    return emOf(line);
                }
                return vertical ? line.width : line.height;
            })
            .filter((value) => Number.isFinite(value) && value >= 4);
        const glyph = glyphSizes.length > 0
            ? glyphSizes.reduce((sum, value) => sum + value, 0) / glyphSizes.length
            : 0;
        // A leaned line's glyph is measured across the glyph itself, so the
        // font is that size. An upright line's thickness is the column width,
        // which is narrower than the font, so it keeps the 1.2 correction.
        const inclinedGroup = placedLines.some((line) => Math.abs(line.angle ?? 0) >= 0.01);
        const font = glyph > 0
            ? Math.max(6, Math.round(glyph * (inclinedGroup ? 1 : 1.2)))
            : (group.fontSize ?? 12);
        console.info(`[typeset] group ${index}: glyph ${glyph.toFixed(1)}px, font ${font}px, ${placedLines.length} line(s), thicknesses ${glyphSizes.map((value) => Math.round(value)).join(',')}`);

        const translatedColumns = (answer?.columns ?? [])
            .map((column) => column.trim())
            .filter(Boolean);
        if (translatedColumns.length === 0) translatedColumns.push(text.trim());
        // A column that repeats the one before it is the model padding the
        // layout, not text: the same phrase split into two columns showed up
        // twice on the page. It is dropped before the columns are laid out.
        const uniqueColumns = translatedColumns.filter((column, at) => (
            at === 0 || column !== translatedColumns[at - 1]
        ));
        const joined = uniqueColumns.join('');
        const trimmed = trimRepeatedHead(joined);
        translatedColumns.length = 0;
        translatedColumns.push(...(trimmed === joined ? uniqueColumns : [trimmed]));

        // The reader found the lines; the translation is fitted into them and
        // no label is ever added beside them. Three steps:
        //
        // 1. A line the translator marked as furigana, or a line whose label
        //    would sit on top of a larger neighbour's, is not a column. Its ink
        //    is still erased above, it just gets no text.
        // 2. The translation comes back cut into pieces that must stay whole
        //    (外星人 is one piece). Without pieces, the translator's columns,
        //    cut at their punctuation, stand in.
        // 3. fitColumns deals whole pieces into the lines by the room each line
        //    has, and returns one font factor that makes every part fit.
        const fontOf = (line: BoxData): number => {
            const size = emOf(line);
            // A leaned line's stroke is the glyph itself. An upright line's is
            // the column width, which is narrower than the glyph, hence the 1.2.
            const grow = Math.abs(line.angle ?? 0) >= 0.01 ? 1 : 1.2;
            return size >= 4 ? Math.max(6, Math.round(size * grow)) : fittedFont;
        };
        const fittedFont = Math.max(6, Math.round(font));

        const rubyTexts = (answer?.ruby ?? [])
            .map((at) => group.lines[at - 1]?.trim())
            .filter((value): value is string => Boolean(value));
        // The reader is told to name furigana columns, and it also names a
        // short kana line that is dialogue: で…… came back as the reading of
        // 花岡さんは and lost its own column. A reading is printed smaller than
        // the line it reads, so only a clearly smaller kana line is dropped.
        const largestFont = Math.max(...placedLines.map(fontOf));
        let layoutLines = placedLines.filter((line) => {
            const at = rubyTexts.indexOf(line.text.trim());
            if (at < 0) return true;
            const kana = line.text.replace(/[\s、。！？…「」『』]/gu, '');
            if (!/^[\u3040-\u309F\u30A0-\u30FF\u30FC]{1,8}$/u.test(kana)
                || fontOf(line) >= largestFont * 0.6) {
                return true;
            }
            rubyTexts.splice(at, 1);
            return false;
        });
        if (layoutLines.length === 0) layoutLines = placedLines;
        if (fromReader && layoutLines.length > 1) {
            const span = (frame: { x: number; y: number; width: number; height: number }, across: boolean): [number, number] => (
                across === vertical ? [frame.x, frame.x + frame.width] : [frame.y, frame.y + frame.height]
            );
            const overlapShare = (left: [number, number], right: [number, number]): number => {
                const shared = Math.min(left[1], right[1]) - Math.max(left[0], right[0]);
                const shorter = Math.min(left[1] - left[0], right[1] - right[0]);
                return shorter > 0 ? Math.max(0, shared) / shorter : 0;
            };
            // Furigana the reader and the translator both missed: a short kana
            // line printed at a clearly smaller size, right beside a larger
            // line it runs alongside.
            const largest = Math.max(...layoutLines.map(fontOf));
            layoutLines = layoutLines.filter((line) => {
                const kana = line.text.replace(/[\s、。！？…「」『』]/gu, '');
                if (!/^[\u3040-\u309F\u30A0-\u30FF\u30FC]{1,8}$/u.test(kana) || fontOf(line) >= largest * 0.7) return true;
                const own = frameOf(line);
                return !layoutLines.some((other) => {
                    if (other === line || fontOf(other) < largest * 0.85) return false;
                    const theirs = frameOf(other);
                    // Furigana packs several kana into the advance of one or
                    // two kanji, so its run is shorter than the column it
                    // reads. ヒーローモノは is a full kana column beside a
                    // full kanji one, not the reading of it.
                    const ownRun = vertical ? own.height : own.width;
                    const hostRun = vertical ? theirs.height : theirs.width;
                    if (ownRun >= hostRun * 0.65) return false;
                    const gap = Math.max(span(theirs, true)[0] - span(own, true)[1], span(own, true)[0] - span(theirs, true)[1], 0);
                    return gap <= fontOf(other) && overlapShare(span(own, false), span(theirs, false)) > 0.5;
                });
            });
            layoutLines = layoutLines.filter((line) => {
                const own = frameOf(line);
                return !layoutLines.some((other) => {
                    if (other === line || fontOf(other) <= fontOf(line)) return false;
                    const theirs = frameOf(other);
                    return overlapShare(span(own, true), span(theirs, true)) > 0.3
                        && overlapShare(span(own, false), span(theirs, false)) > 0.3;
                });
            });
        }

        // The pieces were checked against the translation when they were read;
        // a translation that repeats its own head is cleaned up from the
        // columns instead.
        const pieceText = answer?.segments?.join('') ?? '';
        const segments = answer?.segments && trimRepeatedHead(pieceText) === pieceText
            ? answer.segments
            : fallbackSegments(translatedColumns);
        const fullText = segments.join('');
        const frames = layoutLines.map(frameOf);
        // One speech is set in one size. A column the detector boxed across a
        // gap measured 40px beside two 25px columns, and the middle label was
        // drawn at 36px; the median of the columns is the group's glyph.
        const fonts = layoutLines.map(fontOf);
        const ordered = [...fonts].sort((left, right) => left - right);
        const groupFont = ordered.length % 2 === 0 && ordered.length > 1
            ? (ordered[ordered.length / 2 - 1] + ordered[ordered.length / 2]) / 2
            : ordered[ordered.length >> 1];
        // The shared size is the median, but never above a column's own
        // measured glyph: a 21px label in a 19px column hung a pixel outside
        // its block (bubble-start). One speech, one size, capped per column.
        if (ordered.length > 1) {
            fonts.forEach((font, at) => { fonts[at] = Math.min(groupFont, font); });
        }
        const fromTranslator = segments === answer?.segments;
        const fitOptions = {
            // Pieces the translator marked are words; cutting one costs far
            // more than an uneven fill. Punctuation hints are cheaper to cut.
            insidePenalty: fromTranslator ? 20 : 2,
            preferred: translatedColumns.join('') === fullText ? translatedColumns : undefined,
        };
        // The room a column has is the balloon it sits in, not the ink box the
        // detector drew: a tight box holds 3.5 cells of a 4 character column,
        // so a five character translation was shrunk to 70% and the label
        // floated small in a balloon with room to spare. A column may run
        // further along its own axis; its neighbours are parallel, so that
        // does not crowd them.
        const limits = frames.map((frame, at) => {
            const font = fonts[at];
            const [start, end] = vertical
                ? [frame.y, frame.y + frame.height]
                : [frame.x, frame.x + frame.width];
            if (balloon) {
                const pad = Math.max(3, Math.min(font * 0.45, Math.min(balloon.width, balloon.height) * 0.06));
                return vertical
                    ? [Math.min(balloon.y + pad, start), Math.max(balloon.y + balloon.height - pad, end)]
                    : [Math.min(balloon.x + pad, start), Math.max(balloon.x + balloon.width - pad, end)];
            }
            // No balloon: a caption, a name plate or text inside a screen. The
            // tight DET box holds fewer cells than the block it sits in (150万人
            // が視聴中 has room for eight glyphs in the phone, 5.5 in its box),
            // so a glyph and a fifth of slack on each side is what the block
            // itself gives back. A caption between panel rules keeps its ink.
            const grow = font * 1.2;
            return vertical
                ? [Math.max(0, start - grow), Math.min(imageHeight, end + grow)]
                : [Math.max(0, start - grow), Math.min(imageWidth, end + grow)];
        });
        let capacities = frames.map((frame, at) => (
            (vertical ? frame.height : frame.width) / fonts[at]
        ));
        let fit = fitColumns(segments, capacities, fitOptions);
        if (fit.scale < 0.98) {
            // Grow each column by exactly the deficit, never past its room, and
            // re-deal the text. The font only shrinks by whatever the balloon
            // still cannot hold.
            const grown = frames.map((frame, at) => {
                const base = vertical ? frame.height : frame.width;
                const room = Math.max(base, limits[at][1] - limits[at][0]);
                return Math.max(base, Math.min(room, base / fit.scale)) / fonts[at];
            });
            const wider = fitColumns(segments, grown, fitOptions);
            if (wider.scale > fit.scale) {
                fit = wider;
                capacities = grown;
            }
        }
        // The box the label is drawn on: the part's own length at the font it
        // is drawn with, centred on the source column, inside its room.
        const drawFrameOf = (at: number): { x: number; y: number; width: number; height: number; angle?: number } => {
            const frame = frames[at];
            const fontSize = Math.max(6, Math.round(fonts[at] * fit.scale));
            const part = fit.parts[at] ?? '';
            const characters = [...part].filter((character) => character !== '\u2060' && character !== '\n').length;
            const needed = characters * fontSize * 1.02;
            const [lo, hi] = limits[at];
            const [start, end] = vertical
                ? [frame.y, frame.y + frame.height]
                : [frame.x, frame.x + frame.width];
            const length = Math.min(hi - lo, Math.max(end - start, needed));
            const centre = (start + end) / 2;
            const from = Math.max(lo, Math.min(centre - length / 2, hi - length));
            // A group set at one median size can be a pixel wider than its
            // narrowest column's frame. Centre the glyph in a frame at least
            // its own size, or the label hangs a pixel outside the block.
            const thickness = Math.max(vertical ? frame.width : frame.height, fontSize);
            const acrossCentre = vertical
                ? frame.x + frame.width / 2
                : frame.y + frame.height / 2;
            if (vertical) {
                return { ...frame, x: acrossCentre - thickness / 2, y: from, width: thickness, height: length };
            }
            return { ...frame, y: acrossCentre - thickness / 2, x: from, width: length, height: thickness };
        };
        console.info(`[typeset] group ${index}: ${fit.parts.length} label(s) for ${layoutLines.length} line(s), `
            + `scale ${fit.scale.toFixed(2)}: source ${JSON.stringify(group.lines)}, `
            + `placed ${JSON.stringify(layoutLines.map((line) => line.text))}, ruby ${JSON.stringify(answer?.ruby ?? [])}, `
            + `segments ${JSON.stringify(segments)}, capacity ${JSON.stringify(capacities.map((value) => Number(value.toFixed(1))))}, `
            + `labels ${JSON.stringify(fit.parts)}`);

        const push = (
            line: { x: number; y: number; width: number; height: number; angle?: number },
            content: string,
            sourceFont: number,
        ) => {
            const text = vertical ? toVertical(content) : toHorizontal(content);
            // A part that is only spaces or a word joiner paints nothing. It
            // must not count as a label: the eraser treats the group as covered
            // and the balloon empties out behind an invisible box.
            if (![...text].some((character) => character !== '\u2060' && !/\s/u.test(character))) return;
            const fontSize = Math.max(6, Math.round(sourceFont * fit.scale));
            // Spread the label over its band: a translation with fewer
            // characters than the cells it has room for is spaced out instead
            // of bunching at the start of the block. The spacing is in em, so
            // it follows the font when the fit shrinks it.
            const characters = [...text]
                .filter((character) => character !== '\u2060' && character !== '\n')
                .length;
            const available = vertical ? line.height : line.width;
            const natural = characters * fontSize;
            const spacing = characters >= 2 && natural > 0 && available > natural
                ? Math.min(0.6, available / natural - 1)
                : 0;
            items.push({
                ...line,
                text,
                vertical,
                angle: line.angle,
                groupId: index,
                background: group.background,
                color: group.color,
                maskUrl: group.maskUrl,
                maskBox: group.maskBox,
                rectangle: group.rectangle,
                fontSize,
                ...(spacing > 0 ? { spacing } : {}),
                // The paper patch is drawn under the label even when the erase
                // pass ran, so a fill the model got wrong cannot show through:
                // it is the same paper, clipped to the balloon outline.
                // A reader group already sits on its own box and its ink is
                // erased, so a paper patch would only add a slab behind the
                // label. It stays for detector groups, where the box can be
                // loose and the erase leans on the patch.
                patch: balloon && !fromReader ? {
                    x: line.x,
                    y: line.y,
                    width: line.width,
                    height: line.height,
                } : undefined,
                clip: balloon?.outline && balloon.outline.length >= 3 ? balloon.outline : undefined,
            });
        };

        const placedBefore = items.length;
        if (layoutLines.length === 0) {
            push(tight, fullText, fittedFont);
        } else {
            layoutLines.forEach((_, at) => {
                if (fit.parts[at]) push(drawFrameOf(at), fit.parts[at], fonts[at]);
            });
            // A line the translation did not reach keeps its ink, and so does a
            // line that got no column of its own (furigana) whose nearest
            // column is one of those.
            const unlabelled = new Set(layoutLines.filter((_, at) => !fit.parts[at]?.trim()));
            if (unlabelled.size > 0) {
                const centre = (line: BoxData) => ({ x: line.x + line.width / 2, y: line.y + line.height / 2 });
                for (const line of linesInGroup) {
                    let host = layoutLines.includes(line) ? line : undefined;
                    if (!host) {
                        const own = centre(line);
                        let best = Number.POSITIVE_INFINITY;
                        for (const other of layoutLines) {
                            const at = centre(other);
                            const distance = Math.hypot(at.x - own.x, at.y - own.y);
                            if (distance < best) {
                                best = distance;
                                host = other;
                            }
                        }
                    }
                    if (host && unlabelled.has(host)) keep.push(inkOf(line));
                }
            }
        }

        // The inpaint pass is gated on this: a group that placed nothing must
        // not be erased, or the balloon is left empty with no way back.
        if (items.length > placedBefore) {
            let minX = Number.POSITIVE_INFINITY;
            let minY = Number.POSITIVE_INFINITY;
            let maxX = Number.NEGATIVE_INFINITY;
            let maxY = Number.NEGATIVE_INFINITY;
            for (let at = placedBefore; at < items.length; at += 1) {
                const item = items[at];
                minX = Math.min(minX, item.x);
                minY = Math.min(minY, item.y);
                maxX = Math.max(maxX, item.x + item.width);
                maxY = Math.max(maxY, item.y + item.height);
            }
            labelled.push({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
        } else {
            console.warn(`[typeset] group ${index}: nothing was placed; its ink stays`);
            for (const line of linesInGroup) if (line.kind !== 'sfx') keep.push(inkOf(line));
        }
    });

    if (items.length === 0) throw new Error('The translation returned no dialogue to place.');

    return {
        items,
        answers: out,
        used,
        active,
        skipped,
        withBalloon: countWithBalloon(current, balloons),
        erase,
        keep,
        labelled,
    };
}
