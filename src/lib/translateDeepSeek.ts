/**
 * DeepSeek speaks the OpenAI chat shape. The extension calls it straight from
 * the service worker, so there is no proxy to deploy and no server to keep.
 */
const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';

const SYSTEM = [
    'You translate manga dialogue from Japanese into Traditional Chinese.',
    'Keep the tone of the speaker, and keep it short enough for a speech balloon.',
    'Answer with JSON only: {"lines": ["...", "..."]}.',
    'The array must have the same length and the same order as the input array.',
].join(' ');

export async function translateWithDeepSeek(
    lines: string[],
    apiKey: string,
    target = 'Traditional Chinese',
): Promise<string[]> {
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
                { role: 'system', content: `${SYSTEM} Target language: ${target}.` },
                { role: 'user', content: JSON.stringify({ lines }) },
            ],
        }),
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`DeepSeek answered ${response.status}. ${detail.slice(0, 160)}`);
    }

    const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error('DeepSeek returned no content.');

    const parsed = JSON.parse(content) as { lines?: unknown };
    const translated = parsed.lines;
    if (!Array.isArray(translated)) throw new Error('DeepSeek did not return a line array.');

    return lines.map((line, index) => {
        const value = translated[index];
        return typeof value === 'string' ? value : line;
    });
}
