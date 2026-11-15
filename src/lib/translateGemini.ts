import { buildUserPrompt, readRegions, SYSTEM_PROMPT, type PromptRegion, type RegionAnswer } from './translatePrompt';

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const REQUEST_TIMEOUT_MS = 120_000;

export async function translateWithGemini(regions: PromptRegion[], apiKey: string, signal?: AbortSignal): Promise<RegionAnswer[]> {
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
                'x-goog-api-key': apiKey,
            },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
                contents: [{ role: 'user', parts: [{ text: buildUserPrompt(regions, '繁體中文') }] }],
                generationConfig: { temperature: 0.3, responseMimeType: 'application/json' },
            }),
        });
    } catch (cause) {
        if (signal?.aborted) throw new Error('Cancelled.');
        if (controller.signal.aborted) throw new Error('Gemini did not answer within 2 minutes.');
        throw cause;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
    }

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Gemini answered ${response.status}. ${detail.slice(0, 160)}`);
    }

    const payload = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const content = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error('Gemini returned no content.');
    return readRegions(content, regions);
}
