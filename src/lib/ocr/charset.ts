/** Index 0 is the CTC blank, then one entry per dictionary line, then a space. */
let charsetPromise: Promise<string[]> | null = null;

/** The dictionary ships with the extension; a fetch this slow has stalled. */
const CHARSET_TIMEOUT_MS = 15_000;

export function loadCharset(url: string): Promise<string[]> {
    if (!charsetPromise) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CHARSET_TIMEOUT_MS);
        charsetPromise = fetch(url, { signal: controller.signal })
            .then((response) => {
                if (!response.ok) throw new Error(`The charset request failed with ${response.status}.`);
                return response.text();
            })
            .then((text) => {
                // One dictionary entry is an empty string on purpose, so only the
                // newline at the end of the file may be dropped.
                const lines = text.split('\n');
                if (lines[lines.length - 1] === '') lines.pop();
                return ['', ...lines, ' '];
            })
            .catch((cause: unknown) => {
                charsetPromise = null;
                if (controller.signal.aborted) {
                    throw new Error(`The character dictionary did not load within ${CHARSET_TIMEOUT_MS / 1000} s.`);
                }
                throw cause;
            })
            .finally(() => clearTimeout(timer));
    }
    return charsetPromise;
}
