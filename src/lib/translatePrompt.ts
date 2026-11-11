/**
 * Mirrors the target project: each region says which way it runs, how many
 * columns or lines it had, and the whole sentence as one string. The model
 * answers with a natural translation and, for a vertical region, the split.
 */
export const SYSTEM_PROMPT = [
    '你是專業漫畫本地化譯者，同時是中文潤色編輯。',
    '你會先讀懂整頁上下文與每個氣泡的完整語意，再寫出自然的中文譯文。',
    '不要按日語的欄位順序逐欄直譯，也不要保留日語的倒裝語序。',
    '同一個氣泡裡的多欄屬於同一句話，請合併後再翻譯。',
    '全頁的人稱、語氣與情緒必須一致。',
    '只輸出 JSON，不要輸出解釋。',
].join('\n');

export type PromptRegion = {
    id: string;
    /** 'v' when the region runs vertically, 'h' when it runs horizontally. */
    direction: 'v' | 'h';
    /** The source lines of the region, in reading order. */
    lines: string[];
};

export type RegionAnswer = { text: string; columns?: string[] };

function regionPayload(region: PromptRegion) {
    const plainText = region.lines.join('');
    const targetCount = Math.max(1, region.lines.length);
    return {
        id: region.id,
        direction: region.direction,
        targetColumns: region.direction === 'v' ? targetCount : undefined,
        targetLines: region.direction === 'h' ? targetCount : undefined,
        sourceText: {
            plainText,
            textWithBreaks: region.lines.join('\n'),
            readingOrder: region.direction === 'v' ? 'right-to-left' : 'top-to-bottom',
            [region.direction === 'v' ? 'columns' : 'lines']: region.lines.map((text, index) => ({
                index: index + 1,
                label: `${region.direction === 'v' ? 'column' : 'line'}${index + 1}`,
                text,
            })),
        },
    };
}

export function buildUserPrompt(regions: PromptRegion[], target: string): string {
    return [
        `請把以下文字翻譯成${target}。`,
        '輸入是同一頁的多個氣泡，請按順序理解上下文，但每個 region 分開回答。',
        'sourceText.plainText 是同一氣泡的完整原文，用於理解整句語意。',
        'sourceText.columns 或 sourceText.lines 只是排版分段，不是逐句對應。',
        '回傳格式必須是：',
        '{"regions":[{"id":"...","translation":"...","columns":["..."]}]}',
        '規則：',
        '1. regions 必須覆蓋所有輸入的 id。',
        '2. translation 必須是通順的完整中文，優先符合中文語序與漫畫對白習慣。',
        '3. 允許跨欄重組語意，不要把每一欄當成獨立句子。',
        '4. direction=v 時，再把 translation 拆成 columns，數量不超過 targetColumns。',
        '5. 除 JSON 外不要輸出任何內容。',
        `輸入資料：${JSON.stringify({ regions: regions.map(regionPayload) })}`,
    ].join('\n');
}

function extractJson(content: string): string {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return fenced[1].trim();
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start < 0 || end <= start) return content.trim();
    return content.slice(start, end + 1).trim();
}

/** Read the answers back by id, keeping any column split the model offered. */
export function readRegions(content: string, regions: PromptRegion[]): RegionAnswer[] {
    const parsed = JSON.parse(extractJson(content)) as {
        regions?: { id?: string; translation?: unknown; columns?: unknown }[];
    };
    const list = parsed.regions;
    if (!Array.isArray(list)) throw new Error('The model did not return a regions array.');

    const byId = new Map<string, RegionAnswer>();
    for (const item of list) {
        if (typeof item.id !== 'string' || typeof item.translation !== 'string') continue;
        const text = item.translation.trim();
        if (text.length === 0) continue;
        const columns = Array.isArray(item.columns)
            ? item.columns.filter((value): value is string => typeof value === 'string')
                .map((value) => value.trim())
                .filter(Boolean)
            : undefined;
        byId.set(item.id, { text, columns: columns && columns.length > 0 ? columns : undefined });
    }

    return regions.map((region) => byId.get(region.id) ?? { text: region.lines.join('') });
}
