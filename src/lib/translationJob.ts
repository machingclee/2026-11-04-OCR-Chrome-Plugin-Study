import type { TranslatorChoice } from '../shared/constants';
import type { BoxData, BubbleData, GroupData, OverlayItem } from '../shared/types';
import type { RegionAnswer } from './translatePrompt';
import { canTranslate, translateAll } from './translate';
import { translateWithDeepSeek } from './translateDeepSeek';
import { translateWithGemini } from './translateGemini';
import { safeBreak, toHorizontal, toVertical } from './punct';
import { cropSize } from './warp';

export type TranslationSettings = {
    translator: TranslatorChoice;
    deepSeekKey: string;
    geminiKey: string;
};

export type TranslationJobInput = {
    groups: GroupData[];
    boxes: BoxData[];
    balloons: BubbleData[];
    imageWidth: number;
    imageHeight: number;
    settings: TranslationSettings;
    translateBuiltin?: (lines: string[]) => Promise<string[]>;
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

/** Upright crop of a leaned line, placed so a rotation around its centre lands on the glyphs. */
function placedFrame(line: BoxData): { x: number; y: number; width: number; height: number; angle?: number } {
    const angle = line.angle ?? 0;
    if (Math.abs(angle) < 0.01) {
        return { x: line.x, y: line.y, width: line.width, height: line.height };
    }
    const size = cropSize(line);
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

/** Detect, filter, translate, and lay out one image without touching the page. */
export async function translateGroups(input: TranslationJobInput): Promise<TranslationJobResult> {
    const current = input.groups;
    const { settings, boxes, balloons } = input;

    if (input.signal?.aborted) throw new Error('Cancelled.');
    if (current.length === 0) throw new Error('No text was found on this page.');

    const regions = current.map((group, index) => ({
        id: `r${index + 1}`,
        direction: (group.vertical ?? (group.height > group.width * 1.3) ? 'v' : 'h') as 'v' | 'h',
        lines: group.lines,
    }));

    let active = settings.translator;
    if (active === 'gemini' && settings.geminiKey.trim().length === 0 && settings.deepSeekKey.trim().length > 0) {
        active = 'deepseek';
    } else if (active === 'deepseek' && settings.deepSeekKey.trim().length === 0 && settings.geminiKey.trim().length > 0) {
        active = 'gemini';
    }

    const key = active === 'gemini' ? settings.geminiKey.trim() : settings.deepSeekKey.trim();
    let used = active === 'gemini' ? 'Gemini' : active === 'deepseek' ? 'DeepSeek' : 'browser';
    let out: RegionAnswer[] | null = null;

    if (active === 'builtin') {
        const plain = current.map((group) => group.lines.join(''));
        if (input.translateBuiltin) {
            out = (await input.translateBuiltin(plain)).map((text) => ({ text }));
        } else if (canTranslate()) {
            out = (await translateAll(plain, 'ja', 'zh-Hant')).map((text) => ({ text }));
        } else {
            throw new Error('This Chrome build does not expose the browser translator.');
        }
        used = 'browser';
    } else if (key.length > 0) {
        out = active === 'gemini'
            ? await translateWithGemini(regions, key, input.signal)
            : await translateWithDeepSeek(regions, key, input.signal);
    } else if (canTranslate()) {
        used = 'browser (no API key)';
        const plain = current.map((group) => group.lines.join(''));
        out = (await translateAll(plain, 'ja', 'zh-Hant')).map((text) => ({ text }));
    }

    if (!out) {
        throw new Error(
            active === 'builtin'
                ? 'This Chrome ships no translator. Pick Gemini or DeepSeek and paste a key.'
                : `Paste a ${active === 'gemini' ? 'Gemini' : 'DeepSeek'} key above.`,
        );
    }

    const items: OverlayItem[] = [];
    const erase: EraseBox[] = [];
    let skipped = 0;

    current.forEach((group, index) => {
        const answer = out[index];
        if (answer?.skip || answer?.type === 'sfx') {
            skipped += 1;
            return;
        }
        const text = answer?.text ?? group.lines.join('');
        if (text.trim().length === 0) {
            skipped += 1;
            return;
        }

        const centreX = group.x + group.width / 2;
        const centreY = group.y + group.height / 2;
        const balloon = group.balloon
            ? balloons.find((bubble) =>
                centreX >= bubble.x && centreX <= bubble.x + bubble.width
                && centreY >= bubble.y && centreY <= bubble.y + bubble.height)
            : undefined;
        const linesInGroup = boxes.filter((line) => {
            const x = line.x + line.width / 2;
            const y = line.y + line.height / 2;
            return line.text.trim().length > 0
                && x >= group.x && x <= group.x + group.width
                && y >= group.y && y <= group.y + group.height;
        });
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
        const bodyLines = thickest > 0
            ? sortedLines.filter((line) => strokeOf(line) >= thickest / 1.6)
            : sortedLines;
        const placedLines = bodyLines.length > 0 ? bodyLines : sortedLines;
        // A group can come back with fewer columns than it had. The spare source
        // line would otherwise keep its ink, because only labelled frames are erased.
        for (const line of linesInGroup) erase.push(placedFrame(line));

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

        const glyphSizes = placedLines
            .map((line) => {
                if (Math.abs(line.angle ?? 0) >= 0.01 && line.lineThickness && line.lineThickness >= 4) {
                    return line.lineThickness;
                }
                return vertical ? line.width : line.height;
            })
            .filter((value) => Number.isFinite(value) && value >= 4);
        const glyph = glyphSizes.length > 0
            ? glyphSizes.reduce((sum, value) => sum + value, 0) / glyphSizes.length
            : 0;
        const font = glyph > 0 ? Math.max(6, Math.round(glyph * 1.2)) : (group.fontSize ?? 12);

        const sourceColumns = group.lines.map((line) => line.trim()).filter(Boolean);
        const sourceLengths = sourceColumns.map((line) => [...line].length);
        const baseline = Math.max(1, ...sourceLengths);
        const translatedColumns = (answer?.columns ?? [])
            .map((column) => column.trim())
            .filter(Boolean);
        if (translatedColumns.length === 0) translatedColumns.push(text.trim());

        const columns: string[] = [];
        let carry = '';
        const targetCount = Math.max(sourceLengths.length, translatedColumns.length, 1);
        for (let index = 0; index < targetCount || carry.length > 0; index += 1) {
            const current = `${carry}${translatedColumns[index] ?? ''}`.trim();
            carry = '';
            if (!current) continue;
            const own = sourceLengths[index] ?? sourceLengths[sourceLengths.length - 1] ?? baseline;
            const length = [...current].length;
            const isLast = index >= targetCount - 1;
            if (length <= own || length <= baseline || isLast) {
                columns.push(current);
                continue;
            }
            const chars = [...current];
            const cut = safeBreak(chars, baseline);
            columns.push(chars.slice(0, cut).join(''));
            carry = chars.slice(cut).join('');
        }

        if (placedLines.length > 0 && columns.length > 0 && columns.length !== placedLines.length) {
            const chars = [...columns.join('')];
            const per = Math.max(1, Math.ceil(chars.length / placedLines.length));
            columns.length = 0;
            for (let index = 0; index < placedLines.length; index += 1) {
                columns.push(chars.slice(index * per, (index + 1) * per).join(''));
            }
        }

        const push = (line: { x: number; y: number; width: number; height: number; angle?: number }, content: string) => {
            items.push({
                x: line.x,
                y: line.y,
                width: line.width,
                height: line.height,
                text: vertical ? toVertical(content) : toHorizontal(content),
                vertical,
                angle: line.angle,
                groupId: index,
                background: group.background,
                color: group.color,
                maskUrl: group.maskUrl,
                maskBox: group.maskBox,
                rectangle: group.rectangle,
                fontSize: fittedFont,
                // The paper patch is drawn under the label even when the erase
                // pass ran, so a fill the model got wrong cannot show through:
                // it is the same paper, clipped to the balloon outline.
                patch: balloon ? {
                    x: line.x,
                    y: line.y,
                    width: line.width,
                    height: line.height,
                } : undefined,
                clip: balloon?.outline && balloon.outline.length >= 3 ? balloon.outline : undefined,
            });
        };

        const fittedFont = Math.max(6, Math.round(font));

        if (columns.length > 1 && columns.length <= placedLines.length) {
            placedLines.slice(0, columns.length).forEach((line, columnIndex) => {
                push(placedFrame(line), columns[columnIndex]);
            });
        } else if (placedLines.length === 1) {
            push(placedFrame(placedLines[0]), columns.join(''));
        } else {
            push(tight, columns.join(''));
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
    };
}
