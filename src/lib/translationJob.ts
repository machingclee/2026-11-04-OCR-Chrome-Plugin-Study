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

function minAreaBox(points: Array<{ x: number; y: number }>): { x: number; y: number; width: number; height: number; angle: number } | null {
    if (points.length < 3) return null;
    const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
        (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower: Array<{ x: number; y: number }> = [];
    for (const point of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
        lower.push(point);
    }
    const upper: Array<{ x: number; y: number }> = [];
    for (const point of [...sorted].reverse()) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
        upper.push(point);
    }
    const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
    let best: { x: number; y: number; width: number; height: number; angle: number; area: number } | null = null;
    for (let index = 0; index < hull.length; index += 1) {
        const a = hull[index];
        const b = hull[(index + 1) % hull.length];
        const edge = Math.atan2(b.y - a.y, b.x - a.x);
        const cos = Math.cos(-edge);
        const sin = Math.sin(-edge);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const point of hull) {
            const x = point.x * cos - point.y * sin;
            const y = point.x * sin + point.y * cos;
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
        const width = maxX - minX;
        const height = maxY - minY;
        const area = width * height;
        if (width > 0 && height > 0 && (!best || area < best.area)) {
            const cx = (minX + maxX) / 2;
            const cy = (minY + maxY) / 2;
            const x = cx * Math.cos(edge) - cy * Math.sin(edge);
            const y = cx * Math.sin(edge) + cy * Math.cos(edge);
            best = { x: x - width / 2, y: y - height / 2, width, height, angle: edge, area };
        }
    }
    return best;
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
        // Manga dialogue is vertical. Force every translated label to the
        // vertical writing mode so a wide balloon cannot flip it horizontal.
        const vertical = true;

        const corners = linesInGroup.flatMap((line) => [
            { x: line.x, y: line.y },
            { x: line.x + line.width, y: line.y },
            { x: line.x, y: line.y + line.height },
            { x: line.x + line.width, y: line.y + line.height },
        ]);
        const box = minAreaBox(corners) ?? {
            x: group.x, y: group.y, width: group.width, height: group.height, angle: 0,
        };
        const glyphSizes = linesInGroup
            .map((line) => vertical ? line.width : line.height)
            .filter((value) => Number.isFinite(value) && value >= 4);
        const glyph = glyphSizes.length > 0
            ? glyphSizes.reduce((sum, value) => sum + value, 0) / glyphSizes.length
            : 0;
        const font = glyph > 0 ? Math.max(6, Math.round(glyph)) : group.fontSize;

        items.push({
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            angle: box.angle,
            text: vertical ? toVertical(text) : toHorizontal(text),
            vertical,
            groupId: index,
            background: group.background,
            color: group.color,
            maskUrl: group.maskUrl,
            maskBox: group.maskBox,
            rectangle: group.rectangle,
            fontSize: font,
            patch: balloon && !input.inpainted ? {
                x: group.x,
                y: group.y,
                width: group.width,
                height: group.height,
            } : undefined,
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
