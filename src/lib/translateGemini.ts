/**
 * Gemini answers on the same free tier as AI Studio, so a key from there is
 * enough. The request asks for JSON so the line count stays in step.
 */
const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const PROMPT = [
    'You translate manga dialogue from Japanese into Traditional Chinese.',
    'Keep the tone of the speaker, and keep each line short enough for a speech balloon.',
    'Answer with JSON only, shaped like {"lines": ["...", "..."]}.',
    'The array must have the same length and the same order as the input array.',
].join(' ');

export async function translateWithGemini(lines: string[], apiKey: string): Promise<string[]> {
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
            contents: [
                {
                    role: 'user',
                    parts: [{ text: `${PROMPT}\n\n${JSON.stringify({ lines })}` }],
                },
            ],
            generationConfig: { temperature: 0.3, responseMimeType: 'application/json' },
        }),
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Gemini answered ${response.status}. ${detail.slice(0, 160)}`);
    }

    const payload = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const content = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error('Gemini returned no content.');

    const parsed = JSON.parse(content) as { lines?: unknown };
    const translated = parsed.lines;
    if (!Array.isArray(translated)) throw new Error('Gemini did not return a line array.');

    return lines.map((line, index) => {
        const value = translated[index];
        return typeof value === 'string' ? value : line;
    });
}
