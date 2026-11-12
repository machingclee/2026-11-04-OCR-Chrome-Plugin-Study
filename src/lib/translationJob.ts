import type { TranslatorChoice } from '../shared/constants';
import type { BoxData, BubbleData, GroupData, OverlayItem } from '../shared/types';
import type { RegionAnswer } from './translatePrompt';
import { canTranslate, translateAll } from './translate';
import { translateWithDeepSeek } from './translateDeepSeek';
import { translateWithGemini } from './translateGemini';
import { classifyVisionCandidates, type VisionProvider } from './visionClassify';
import { safeBreak, toHorizontal, toVertical } from './punct';

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
    inpainted?: boolean;
    translateBuiltin?: (lines: string[]) => Promise<string[]>;
};

export type TranslationJobResult = {
    items: OverlayItem[];
    answers: RegionAnswer[];
    used: string;
    active: TranslatorChoice;
    skipped: number;
    withBalloon: number;
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

function visionProvider(settings: TranslationSettings): VisionProvider | null {
    if (settings.translator === 'deepseek' && settings.deepSeekKey.trim().length > 0) {
        return { kind: 'deepseek', apiKey: settings.deepSeekKey.trim() };
    }
    if (settings.translator === 'gemini' && settings.geminiKey.trim().length > 0) {
        return { kind: 'gemini', apiKey: settings.geminiKey.trim() };
    }
    if (settings.deepSeekKey.trim().length > 0) {
        return { kind: 'deepseek', apiKey: settings.deepSeekKey.trim() };
    }
    if (settings.geminiKey.trim().length > 0) {
        return { kind: 'gemini', apiKey: settings.geminiKey.trim() };
    }
    return null;
}

/** Detect, filter, translate, and lay out one image without touching the page. */
export async function translateGroups(input: TranslationJobInput): Promise<TranslationJobResult> {
    let current = input.groups;
    let pageWidth = input.imageWidth;
    let pageHeight = input.imageHeight;
    const { settings, boxes, balloons } = input;
    let visionSkipped = 0;

    const provider = visionProvider(settings);
    if (current.length > 0 && provider) {
        const candidates = current
            .map((group, index) => ({
                index,
                crop: group.visionCrop ?? '',
                text: group.lines.join(''),
            }))
            .filter((candidate) => candidate.crop.length > 0);
        if (candidates.length > 0) {
            const verdicts = await classifyVisionCandidates(candidates, provider);
            const removed = new Set<number>();
            for (const candidate of candidates) {
                const verdict = verdicts.get(candidate.index);
                if (verdict === 'sfx' || verdict === 'false_positive') removed.add(candidate.index);
            }
            if (removed.size > 0) {
                visionSkipped = removed.size;
                current = current.filter((_, index) => !removed.has(index));
            }
        }
    }

    if (current.length === 0) throw new Error('No text was found on this page.');
    if (pageWidth <= 0 || pageHeight <= 0) {
        pageWidth = Math.max(...boxes.map((box) => box.x + box.width), 1);
        pageHeight = Math.max(...boxes.map((box) => box.y + box.height), 1);
    }

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
            ? await translateWithGemini(regions, key)
            : await translateWithDeepSeek(regions, key);
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
    let skipped = visionSkipped;

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

        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (const line of linesInGroup) {
            minX = Math.min(minX, line.x);
            minY = Math.min(minY, line.y);
            maxX = Math.max(maxX, line.x + line.width);
            maxY = Math.max(maxY, line.y + line.height);
        }
        const tight = Number.isFinite(minX) && maxX > minX && maxY > minY
            ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
            : { x: group.x, y: group.y, width: group.width, height: group.height };

        const glyphSizes = linesInGroup
            .map((line) => vertical ? line.width : line.height)
            .filter((value) => Number.isFinite(value) && value >= 4);
        const glyph = glyphSizes.length > 0
            ? glyphSizes.reduce((sum, value) => sum + value, 0) / glyphSizes.length
            : 0;
        const font = glyph > 0 ? Math.max(6, Math.round(glyph)) : (group.fontSize ?? 12);

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

        const push = (line: { x: number; y: number; width: number; height: number }, content: string) => {
            items.push({
                x: line.x,
                y: line.y,
                width: line.width,
                height: line.height,
                text: vertical ? toVertical(content) : toHorizontal(content),
                vertical,
                groupId: index,
                background: group.background,
                color: group.color,
                maskUrl: group.maskUrl,
                maskBox: group.maskBox,
                rectangle: group.rectangle,
                fontSize: font,
                patch: balloon && !input.inpainted ? {
                    x: line.x,
                    y: line.y,
                    width: line.width,
                    height: line.height,
                } : undefined,
            });
        };

        // Align tops only within the same detected text band. Two lobes can
        // have very different tops, so one shared top for the whole group would
        // move one lobe's columns into the other.
        const tops = new Map<typeof sortedLines[number], number>();
        const byTop = [...sortedLines].sort((left, right) => left.y - right.y);
        let bandTop = byTop[0]?.y ?? 0;
        for (const line of byTop) {
            if (line.y - bandTop > Math.max(4, font * 0.8)) bandTop = line.y;
            tops.set(line, bandTop);
        }

        if (columns.length > 1 && columns.length <= sortedLines.length) {
            sortedLines.slice(0, columns.length).forEach((line, columnIndex) => {
                push({ ...line, y: tops.get(line) ?? line.y }, columns[columnIndex]);
            });
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
    };
}
