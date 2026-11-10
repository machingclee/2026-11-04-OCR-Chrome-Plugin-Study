/** Index 0 is the CTC blank, then one entry per dictionary line, then a space. */
let charsetPromise: Promise<string[]> | null = null;

export function loadCharset(url: string): Promise<string[]> {
    if (!charsetPromise) {
        charsetPromise = fetch(url)
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
                throw cause;
            });
    }
    return charsetPromise;
}
