import { DEFAULT_REASONING_EFFORT } from '../shared/constants';
import type { ReasoningEffort } from '../shared/constants';
import { buildUserPrompt, readRegions, SYSTEM_PROMPT, type PromptRegion, type RegionAnswer } from './translatePrompt';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-flash';
const REQUEST_TIMEOUT_MS = 120_000;

export async function translateWithDeepSeek(
    regions: PromptRegion[],
    apiKey: string,
    signal?: AbortSignal,
    effort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
    /** The other blocks of the page, kept as context and not translated. */
    context: string[] = [],
): Promise<RegionAnswer[]> {
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
                // Translation is not a place for invention: the same page measured
                // three times gave 告訴他 / 告訴你 / 告訴你 at 0.3, and 告訴你 three
                // times out of three at 0. A faithful translation wants the same
                // answer, and with thinking off the sampling is what is left to
                // vary.
                temperature: 0,
                response_format: { type: 'json_object' },
                // The effort comes from the popup, so one setting governs the
                // reading and the translation alike. There is one request per
                // page here, so the cost is bounded by the page rather than by
                // the number of blocks.
                ...(effort === 'off'
                    ? { thinking: { type: 'disabled' } }
                    : { thinking: { type: 'enabled' }, reasoning_effort: effort }),
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: buildUserPrompt(regions, '繁體中文', context) },
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

    const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error('DeepSeek returned no content.');
    console.info(`[translate] deepseek effort ${effort}, tokens ${payload.usage?.completion_tokens ?? '?'}, `
        + `reasoning ${payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0}`);
    return readRegions(content, regions);
}
