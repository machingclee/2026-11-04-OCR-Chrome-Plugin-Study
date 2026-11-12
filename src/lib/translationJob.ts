import type { TranslatorChoice } from '../shared/constants';
import type { BoxData, BubbleData, GroupData, OverlayItem } from '../shared/types';
import type { RegionAnswer } from './translatePrompt';
import { canTranslate, translateAll } from './translate';
import { translateWithDeepSeek } from './translateDeepSeek';
import { translateWithGemini } from './translateGemini';
import { classifyVisionCandidates, type VisionProvider } from './visionClassify';
import { toHorizontal, toVertical } from './punct';

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
};

export type TranslationJobResult = {
    items: OverlayItem[];
    answers: RegionAnswer[];
    used: string;
    active: TranslatorChoice;
    skipped: number;
    withBalloon: number;
};

function tightenBox(group: GroupData, lines: BoxData[]): GroupData {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const line of lines) {
        const centreX = line.x + line.width / 2;
        const centreY = line.y + line.height / 2;
        if (centreX < group.x || centreX > group.x + group.width) continue;
        if (centreY < group.y || centreY > group.y + group.height) continue;
        minX = Math.min(minX, line.x);
        minY = Math.min(minY, line.y);
        maxX = Math.max(maxX, line.x + line.width);
        maxY = Math.max(maxY, line.y + line.height);
    }

    if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return group;

    const pad = Math.max(3, Math.min(maxX - minX, maxY - minY) * 0.08);
    return {
        ...group,
        x: minX - pad,
        y: minY - pad,
        width: maxX - minX + pad * 2,
        height: maxY - minY + pad * 2,
    };
}

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
        if (!canTranslate()) {
            throw new Error('The background job needs Gemini or DeepSeek. The browser translator is only available inside the popup.');
        }
        used = 'browser';
        const plain = current.map((group) => group.lines.join(''));
        out = (await translateAll(plain, 'ja', 'zh-Hant')).map((text) => ({ text }));
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

    const placements: Array<{
        group: GroupData;
        text: string;
        vertical: boolean;
        layout: GroupData;
        tight: GroupData;
        balloon?: BubbleData;
    }> = [];
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

        const tight = tightenBox(group, boxes);
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
        let layout = tight;
        if (balloon) {
            const left = Math.max(tight.x, balloon.x);
            const right = Math.min(tight.x + tight.width, balloon.x + balloon.width);
            const top = Math.max(tight.y, balloon.y);
            const bottom = Math.min(tight.y + tight.height, balloon.y + balloon.height);
            if (right > left && bottom > top) {
                layout = { ...tight, x: left, y: top, width: right - left, height: bottom - top };
            }
        }
        placements.push({ group, text, vertical, layout, tight, balloon });
    });

    for (let left = 0; left < placements.length; left += 1) {
        for (let right = left + 1; right < placements.length; right += 1) {
            const a = placements[left].layout;
            const b = placements[right].layout;
            const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
            const overlapHeight = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
            if (overlapWidth <= 0 || overlapHeight <= 0) continue;
            const shared = overlapWidth * overlapHeight;
            const smaller = Math.min(a.width * a.height, b.width * b.height);
            if (shared <= smaller * 0.1) continue;
            if (placements[left].group.balloon) placements[left].layout = placements[left].tight;
            if (placements[right].group.balloon) placements[right].layout = placements[right].tight;
        }
    }

    const items: OverlayItem[] = placements.map(({ group, text, vertical, layout, balloon }) => ({
        x: layout.x,
        y: layout.y,
        width: layout.width,
        height: layout.height,
        text: vertical ? toVertical(text) : toHorizontal(text),
        vertical,
        background: group.background,
        color: group.color,
        maskUrl: group.maskUrl,
        maskBox: group.maskBox,
        rectangle: group.rectangle,
        fontSize: group.fontSize,
        clip: balloon?.outline,
        fill: Boolean(balloon) && group.width * group.height <= pageWidth * pageHeight * 0.15,
    }));
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
