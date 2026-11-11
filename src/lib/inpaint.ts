import * as ort from 'onnxruntime-web/wasm';
import { INPAINT_INPUT_SIZE, INPAINT_MODEL_PATH, INPAINT_OVERLAP } from '../shared/constants';

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

export function isInpaintReady(): boolean {
    return sessionPromise !== null;
}

/**
 * Run the model over one 512 square. The image is scaled to minus one to one,
 * the hole is zeroed after that scaling, and the answer is scaled back.
 */
async function runTile(
    source: ImageData,
    mask: Uint8Array,
    width: number,
    height: number,
): Promise<Uint8ClampedArray> {
    const session = await loadSession();
    const inputName = session.inputNames[0];
    const maskName = session.inputNames[1] ?? session.inputNames[0];

    const image = new Float32Array(3 * INPAINT_INPUT_SIZE * INPAINT_INPUT_SIZE);
    const hole = new Float32Array(INPAINT_INPUT_SIZE * INPAINT_INPUT_SIZE);
    const plane = INPAINT_INPUT_SIZE * INPAINT_INPUT_SIZE;

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const target = y * INPAINT_INPUT_SIZE + x;
            const sourceIndex = (y * width + x) * 4;
            const masked = mask[y * width + x] === 1;
            for (let channel = 0; channel < 3; channel += 1) {
                const value = masked ? 0 : source.data[sourceIndex + channel] / 127.5 - 1;
                image[channel * plane + target] = value;
            }
            hole[target] = masked ? 1 : 0;
        }
    }

    const outputs = await session.run({
        [inputName]: new ort.Tensor('float32', image, [1, 3, INPAINT_INPUT_SIZE, INPAINT_INPUT_SIZE]),
        [maskName]: new ort.Tensor('float32', hole, [1, 1, INPAINT_INPUT_SIZE, INPAINT_INPUT_SIZE]),
    });

    const first = Object.values(outputs)[0] as ort.Tensor;
    const data = first.data as Float32Array;
    const out = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const target = y * INPAINT_INPUT_SIZE + x;
            const outIndex = (y * width + x) * 4;
            for (let channel = 0; channel < 3; channel += 1) {
                const value = (data[channel * plane + target] + 1) * 127.5;
                out[outIndex + channel] = Math.max(0, Math.min(255, Math.round(value)));
            }
            out[outIndex + 3] = 255;
        }
    }
    return out;
}

/**
 * Inpaint the whole page tile by tile. Only pixels the mask marked are copied
 * back, so everything outside the text stays exactly as it was.
 */
export async function inpaintPage(
    page: ImageData,
    mask: Uint8Array,
    onProgress?: (done: number, total: number) => void,
): Promise<ImageData> {
    const size = INPAINT_INPUT_SIZE;
    const stride = size - INPAINT_OVERLAP;
    const columns = Math.max(1, Math.ceil((page.width - INPAINT_OVERLAP) / stride));
    const rows = Math.max(1, Math.ceil((page.height - INPAINT_OVERLAP) / stride));
    const result = new Uint8ClampedArray(page.data);
    let done = 0;

    for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
            const x0 = Math.min(page.width - size, column * stride);
            const y0 = Math.min(page.height - size, row * stride);
            if (x0 < 0 || y0 < 0) continue;

            const tile = new ImageData(size, size);
            const tileMask = new Uint8Array(size * size);
            let hasHole = false;

            for (let y = 0; y < size; y += 1) {
                for (let x = 0; x < size; x += 1) {
                    const source = ((y0 + y) * page.width + (x0 + x)) * 4;
                    const target = (y * size + x) * 4;
                    tile.data[target] = page.data[source];
                    tile.data[target + 1] = page.data[source + 1];
                    tile.data[target + 2] = page.data[source + 2];
                    tile.data[target + 3] = 255;
                    const masked = mask[(y0 + y) * page.width + (x0 + x)] === 1;
                    if (masked) hasHole = true;
                    tileMask[y * size + x] = masked ? 1 : 0;
                }
            }

            if (hasHole) {
                const painted = await runTile(tile, tileMask, size, size);
                for (let y = 0; y < size; y += 1) {
                    for (let x = 0; x < size; x += 1) {
                        if (tileMask[y * size + x] === 0) continue;
                        const target = ((y0 + y) * page.width + (x0 + x)) * 4;
                        const source = (y * size + x) * 4;
                        result[target] = painted[source];
                        result[target + 1] = painted[source + 1];
                        result[target + 2] = painted[source + 2];
                    }
                }
            }

            done += 1;
            onProgress?.(done, rows * columns);
        }
    }

    return new ImageData(result, page.width, page.height);
}
