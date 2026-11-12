import * as ort from 'onnxruntime-web/wasm';
import { INPAINT_INPUT_SIZE, INPAINT_MODEL_PATH } from '../shared/constants';

if (ort.env?.wasm) ort.env.wasm.numThreads = 1;

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function loadSession(): Promise<ort.InferenceSession> {
    if (!sessionPromise) {
        sessionPromise = ort.InferenceSession.create(chrome.runtime.getURL(INPAINT_MODEL_PATH), {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
        });
    }
    return sessionPromise;
}

/**
 * Inpaint the page in one pass. The page is scaled into the 512 square the model
 * was exported at, and the answer is scaled back, which is what the target
 * project does instead of tiling. One pass instead of twelve, at the cost of a
 * softer result.
 */
export async function inpaintPage(page: ImageData, mask: Uint8Array): Promise<ImageData> {
    const size = INPAINT_INPUT_SIZE;
    const session = await loadSession();
    const inputName = session.inputNames[0];
    const maskName = session.inputNames[1] ?? session.inputNames[0];

    const plane = size * size;
    const image = new Float32Array(3 * plane);
    const hole = new Float32Array(plane);

    for (let y = 0; y < size; y += 1) {
        const sourceY = Math.min(page.height - 1, Math.floor((y * page.height) / size));
        for (let x = 0; x < size; x += 1) {
            const sourceX = Math.min(page.width - 1, Math.floor((x * page.width) / size));
            const source = (sourceY * page.width + sourceX) * 4;
            const target = y * size + x;
            const masked = mask[sourceY * page.width + sourceX] === 1;
            hole[target] = masked ? 1 : 0;
            for (let channel = 0; channel < 3; channel += 1) {
                image[channel * plane + target] = masked
                    ? 0
                    : page.data[source + channel] / 127.5 - 1;
            }
        }
    }

    const outputs = await session.run({
        [inputName]: new ort.Tensor('float32', image, [1, 3, size, size]),
        [maskName]: new ort.Tensor('float32', hole, [1, 1, size, size]),
    });

    const first = Object.values(outputs)[0] as ort.Tensor;
    const data = first.data as Float32Array;
    const result = new Uint8ClampedArray(page.data);

    for (let y = 0; y < page.height; y += 1) {
        const sourceY = Math.min(size - 1, Math.floor((y * size) / page.height));
        for (let x = 0; x < page.width; x += 1) {
            const index = y * page.width + x;
            if (mask[index] !== 1) continue;
            const sourceX = Math.min(size - 1, Math.floor((x * size) / page.width));
            const source = sourceY * size + sourceX;
            const target = index * 4;
            for (let channel = 0; channel < 3; channel += 1) {
                const value = (data[channel * plane + source] + 1) * 127.5;
                result[target + channel] = Math.max(0, Math.min(255, Math.round(value)));
            }
        }
    }

    return new ImageData(result, page.width, page.height);
}
