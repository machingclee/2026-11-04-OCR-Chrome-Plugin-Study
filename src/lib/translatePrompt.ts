/**
 * The prompt follows the target project: translate the page as one scene, not
 * one column at a time, because Japanese columns split a single sentence.
 */
export const SYSTEM_PROMPT = [
    '你是專業漫畫本地化譯者，同時是中文潤色編輯。',
    '你會先讀懂整頁上下文與每個氣泡的完整語意，再寫出自然的中文譯文。',
    '不要按日語的欄位順序逐欄直譯，也不要保留日語的倒裝語序。',
    '同一個氣泡裡的多欄屬於同一句話，請合併後再翻譯。',
    '全頁的人稱、語氣與情緒必須一致。',
    '只輸出 JSON，不要輸出解釋。',
].join('\n');

export type PromptRegion = { id: string; text: string };

export function buildUserPrompt(regions: PromptRegion[], target: string): string {
    return [
        `請把以下文字翻譯成${target}。`,
        '輸入是同一頁的多個氣泡，請按順序理解上下文，但每個 region 分開回答。',
        'text 是同一個氣泡內所有行的原文，行與行之間可能只是排版換行。',
        '回傳格式必須是：',
        '{"regions":[{"id":"...","translation":"..."}]}',
        '規則：',
        '1. regions 必須覆蓋所有輸入的 id。',
        '2. translation 必須是通順的完整中文，優先符合中文語序與漫畫對白習慣。',
        '3. 允許跨行重組語意，不要把每一行當成獨立句子。',
        '4. 除 JSON 外不要輸出任何內容。',
        `輸入資料：${JSON.stringify({ regions })}`,
    ].join('\n');
}

/** Read the regions array back, falling back to the original text per id. */
export function readRegions(content: string, regions: PromptRegion[]): string[] {
    const parsed = JSON.parse(content) as { regions?: { id?: string; translation?: unknown }[] };
    const list = parsed.regions;
    if (!Array.isArray(list)) throw new Error('The model did not return a regions array.');

    const byId = new Map<string, string>();
    for (const item of list) {
        if (typeof item.id === 'string' && typeof item.translation === 'string') {
            byId.set(item.id, item.translation);
        }
    }
    return regions.map((region) => byId.get(region.id) ?? region.text);
}
