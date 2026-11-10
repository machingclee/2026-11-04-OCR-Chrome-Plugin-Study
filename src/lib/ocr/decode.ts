import type { OcrResult } from '../types';

const BLANK = 0;

/** Greedy CTC: keep the argmax of each step, drop blanks, collapse repeats. */
export function decodeCtc(logits: Float32Array, timeSteps: number, classes: number, charset: string[]): OcrResult {
    const tokens: number[] = [];
    const kept: number[] = [];
    let previous = -1;

    for (let step = 0; step < timeSteps; step += 1) {
        let best = 0;
        let bestScore = logits[step * classes];
        for (let index = 1; index < classes; index += 1) {
            const score = logits[step * classes + index];
            if (score > bestScore) {
                bestScore = score;
                best = index;
            }
        }

        if (best === BLANK) {
            previous = -1;
            continue;
        }
        if (best === previous) continue;

        tokens.push(best);
        kept.push(bestScore);
        previous = best;
    }

    const text = tokens.map((token) => charset[token] ?? '').join('');
    const confidence =
        kept.length === 0
            ? 0
            : Math.exp(kept.reduce((sum, score) => sum + Math.log(Math.max(score, 1e-10)), 0) / kept.length);

    return { text, confidence };
}
