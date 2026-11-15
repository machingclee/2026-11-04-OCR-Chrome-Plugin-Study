import { buildUserPrompt, readRegions, SYSTEM_PROMPT, type PromptRegion, type RegionAnswer } from './translatePrompt';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-flash';
const REQUEST_TIMEOUT_MS = 120_000;

export async function translateWithDeepSeek(regions: PromptRegion[], apiKey: string, signal?: AbortSignal): Promise<RegionAnswer[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const stop = () => controller.abort();
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop);
    let response: Response;
    try {
        response = await fetch(ENDPOINT, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: MODEL,
                temperature: 0.3,
                response_format: { type: 'json_object' },
                // Thinking is on by default at high effort. A page of JSON does not need that chain of thought.
                thinking: { type: 'disabled' },
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: buildUserPrompt(regions, '繁體中文') },
                ],
            }),
        });
    } catch (cause) {
        if (signal?.aborted) throw new Error('Cancelled.');
        if (controller.signal.aborted) throw new Error('DeepSeek did not answer within 2 minutes.');
        throw cause;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
    }

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`DeepSeek answered ${response.status}. ${detail.slice(0, 160)}`);
    }

    const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error('DeepSeek returned no content.');
    return readRegions(content, regions);
}
