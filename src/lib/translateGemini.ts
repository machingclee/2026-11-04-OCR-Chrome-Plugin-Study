import { buildUserPrompt, readRegions, SYSTEM_PROMPT, type PromptRegion, type RegionAnswer } from './translatePrompt';

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

export async function translateWithGemini(regions: PromptRegion[], apiKey: string): Promise<RegionAnswer[]> {
    const response = await fetch(ENDPOINT, {
        method: 'POST',
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
