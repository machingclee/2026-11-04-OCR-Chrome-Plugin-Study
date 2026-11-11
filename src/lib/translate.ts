/** A translator the browser ships, so no key and no network call of ours. */
type TranslatorApi = {
    create: (options: { sourceLanguage: string; targetLanguage: string }) => Promise<{
        translate: (text: string) => Promise<string>;
    }>;
};

function api(): TranslatorApi | null {
    const candidate = (globalThis as unknown as { Translator?: TranslatorApi }).Translator;
    return candidate ?? null;
}

export function canTranslate(): boolean {
    return api() !== null;
}

/**
 * Translate one sentence at a time. The browser translator is small and per
 * language pair, so it is asked once and reused for every group on the page.
 */
export async function translateAll(lines: string[], source: string, target: string): Promise<string[]> {
    const translator = api();
    if (!translator) return lines;

    const session = await translator.create({ sourceLanguage: source, targetLanguage: target });
    const out: string[] = [];
    for (const line of lines) {
        out.push(await session.translate(line).catch(() => line));
    }
    return out;
}
