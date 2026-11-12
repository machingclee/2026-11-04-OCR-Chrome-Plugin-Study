import type { TranslatorChoice } from '../shared/constants';
import type { BoxData, BubbleData, GroupData, OverlayItem } from '../shared/types';
import type { RegionAnswer } from './translatePrompt';
import { canTranslate, translateAll } from './translate';
import { translateWithDeepSeek } from './translateDeepSeek';
import { translateWithGemini } from './translateGemini';
import { classifyVisionCandidates, type VisionProvider } from './visionClassify';
import { safeBreak, toHorizontal, toUnits, toVertical } from './punct';

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

    function splitColumns(text: string, count: number): string[] {
        if (count <= 1) return [text];
        let rest = toUnits(text);
        const chunks: string[] = [];
        for (let index = 0; index < count; index += 1) {
            const remaining = count - index;
            if (remaining <= 1) {
                chunks.push(rest.join(''));
                break;
            }
            const target = Math.max(1, Math.ceil(rest.length / remaining));
            const cut = safeBreak(rest, target);
            chunks.push(rest.slice(0, cut).join(''));
            rest = rest.slice(cut);
        }
        return chunks;
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
        const vertical = balloon
            ? balloon.height > balloon.width * 1.15 || group.vertical === true
            : group.vertical ?? group.height > group.width * 1.3;

        const lineBoxes = boxes
            .filter((line) => {
                const x = line.x + line.width / 2;
                const y = line.y + line.height / 2;
                return line.text.trim().length > 0
                    && x >= group.x && x <= group.x + group.width
                    && y >= group.y && y <= group.y + group.height;
            })
            .sort((left, right) => vertical
                ? (right.x + right.width / 2) - (left.x + left.width / 2)
                : (left.y + left.height / 2) - (right.y + right.height / 2));

        const detected = lineBoxes.length > 0 ? lineBoxes : [{
            x: group.x,
            y: group.y,
            width: group.width,
            height: group.height,
            direction: vertical ? 'vertical' as const : 'horizontal' as const,
            score: 1,
            ruby: [],
            text,
            confidence: 1,
        }];
        const modelColumns = answer?.columns?.filter((value) => value.trim().length > 0) ?? [];
        const chunks = modelColumns.length === detected.length
            ? modelColumns
            : splitColumns(text, detected.length);

        const glyphSizes = detected
            .map((line) => vertical ? line.width : line.height)
            .filter((size) => Number.isFinite(size) && size >= 4)
            .sort((left, right) => left - right);
        const glyph = glyphSizes.length > 0 ? glyphSizes[glyphSizes.length >> 1] : 0;
        const font = glyph > 0 ? Math.max(6, Math.round(glyph * 0.9)) : group.fontSize;

        detected.forEach((line, columnIndex) => {
            const part = chunks[columnIndex]?.trim();
            if (!part) return;
            const tight = { x: line.x, y: line.y, width: line.width, height: line.height };
            items.push({
                x: tight.x,
                y: tight.y,
                width: tight.width,
                height: tight.height,
                text: vertical ? toVertical(part) : toHorizontal(part),
                vertical,
                groupId: index,
                background: group.background,
                color: group.color,
                maskUrl: group.maskUrl,
                maskBox: group.maskBox,
                rectangle: group.rectangle,
                fontSize: font,
                patch: balloon && !input.inpainted ? {
                    x: tight.x,
                    y: tight.y,
                    width: tight.width,
                    height: tight.height,
                } : undefined,
            });
        });
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
