import { buildUserPrompt, readRegions, SYSTEM_PROMPT, type PromptRegion, type RegionAnswer } from './translatePrompt';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';

export async function translateWithDeepSeek(regions: PromptRegion[], apiKey: string): Promise<RegionAnswer[]> {
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: MODEL,
            temperature: 0.3,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: buildUserPrompt(regions, '繁體中文') },
            ],
        }),
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`DeepSeek answered ${response.status}. ${detail.slice(0, 160)}`);
    }

    const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error('DeepSeek returned no content.');
    return readRegions(content, regions);
}
