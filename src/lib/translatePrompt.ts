/**
 * Mirrors the target project: each region says which way it runs, how many
 * columns or lines it had, and the whole sentence as one string. The model
 * answers with a natural translation and, for a vertical region, the split.
 */
export const SYSTEM_PROMPT = [
    '你是專業日文漫畫本地化譯者，把日文台詞翻成自然、口語的繁體中文。',
    '先讀懂整頁上下文與每個文本框的完整語意，再翻譯；不要逐欄直譯，也不要保留日文倒裝語序。',
    '同一個氣泡裡的多欄或行屬於同一句話，先合併理解，再按中文語序重寫。',
    '人名、暱稱、帳號、品牌、作品名保留原文拉丁字母或日文寫法，不要自行音譯；只有通行中文譯名才使用中文。',
    '手機／聊天軟體的 UI 不是台詞：時間戳（上午02:10、午前2:10 等）、未接來電、購買次數、訊號、電量、按鈕、系統提示都不要翻譯，回傳 skip=true。',
    '若整個 region 是 UI 或名稱清單，skip=true；若 region 混合台詞與 UI，只翻譯台詞，不要把 UI 字串放進譯文。',
    '擬音、オノマトペ、效果音（如ドドド、ゴゴゴ、ザワザワ、ドン、バン、ガシャ）不是台詞，不要翻譯；回傳 skip=true、translation=""。',
    '不要發明原文沒有的內容。OCR 明顯錯字時取最合理的讀法。',
    '全頁的人稱、語氣、角色稱呼與情緒必須一致，同一句話不要在同頁出現兩種譯法。',
    '只輸出 JSON，不要輸出解釋或原文。',
].join('\n');

export type PromptRegion = {
    id: string;
    /** 'v' when the region runs vertically, 'h' when it runs horizontally. */
    direction: 'v' | 'h';
    /** The source lines of the region, in reading order. */
    lines: string[];
};

export type RegionAnswer = { text: string; columns?: string[]; /** True for UI, timestamps and name lists. */ skip?: boolean };

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
        '{"regions":[{"id":"...","translation":"...","columns":["..."],"skip":false}]}',
        '規則：',
        '1. regions 必須覆蓋所有輸入的 id。',
        '2. translation 必須是通順的完整中文，優先符合中文語序與漫畫對白習慣；不要保留日文語序或逐欄直譯。',
        '3. sourceText 的多欄／多行只是排版斷裂，允許跨欄重組語意，不要把每一欄當成獨立句子。',
        '4. direction=v 時，再把 translation 拆成 columns，數量不超過 targetColumns；direction=h 時可拆成 lines，數量不超過 targetLines。',
        '5. 人名、暱稱、帳號、品牌、作品名保留原文寫法；不要音譯，也不要改寫成中文。',
        '6. 時間戳、未接來電、購買次數、訊號、按鈕、系統提示等 UI 字串不要翻譯，也不要放進 translation；整個 region 都是這類內容時回傳 skip=true 和 translation=""。',
        '7. 擬音、オノマトペ、效果音（重複假名或短促的カタカナ/ひらがな，如ドドド、ゴゴゴ、ザワザワ、ドン、バン、ガシャ）不要翻譯；整個 region 都是這類內容時回傳 skip=true、translation=""。',
        '8. 混合台詞與 UI 或擬音的 region 只翻譯台詞，skip=false。',
        '9. OCR 有錯字或斷字時，取最合理的讀法；不要發明原文沒有的內容。',
        '10. 除 JSON 外不要輸出任何內容。',
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
        regions?: { id?: string; translation?: unknown; columns?: unknown; skip?: unknown }[];
    };
    const list = parsed.regions;
    if (!Array.isArray(list)) throw new Error('The model did not return a regions array.');

    const byId = new Map<string, RegionAnswer>();
    for (const item of list) {
        if (typeof item.id !== 'string') continue;
        const text = typeof item.translation === 'string' ? item.translation.trim() : '';
        const skip = item.skip === true || item.skip === 'true';
        if (!skip && text.length === 0) continue;
        const columns = Array.isArray(item.columns)
            ? item.columns.filter((value): value is string => typeof value === 'string')
                .map((value) => value.trim())
                .filter(Boolean)
            : undefined;
        byId.set(item.id, {
            text,
            columns: columns && columns.length > 0 ? columns : undefined,
            skip: skip ? true : undefined,
        });
    }

    return regions.map((region) => byId.get(region.id) ?? { text: region.lines.join('') });
}
