import * as ort from 'onnxruntime-web/webgpu';
import { INPAINT_INPUT_SIZE, INPAINT_MODEL_PATH } from '../shared/constants';

if (ort.env?.wasm) ort.env.wasm.numThreads = 1;

const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator;

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function loadSession(): Promise<ort.InferenceSession> {
    if (!sessionPromise) {
        sessionPromise = ort.InferenceSession.create(chrome.runtime.getURL(INPAINT_MODEL_PATH), {
            executionProviders: webgpu ? ['webgpu', 'wasm'] : ['wasm'],
            graphOptimizationLevel: 'all',
        }).catch(async (cause: unknown) => {
            if (!webgpu) {
                sessionPromise = null;
                throw cause;
            }
            console.warn('WebGPU inpaint failed, using WASM.', cause);
            try {
                return await ort.InferenceSession.create(chrome.runtime.getURL(INPAINT_MODEL_PATH), {
                    executionProviders: ['wasm'],
                    graphOptimizationLevel: 'all',
                });
            } catch (fallbackCause) {
                sessionPromise = null;
                throw fallbackCause;
            }
        });
    }
    void sessionPromise.then(() => console.info(`Inpaint provider: ${webgpu ? 'webgpu preferred' : 'wasm'}`));
    return sessionPromise;
}

function canvas2d(width: number, height: number): OffscreenCanvasRenderingContext2D {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Inpaint could not create a canvas.');
    return context;
}

/** Bilinear resize, the same draw the target project uses for the 512 square. */
export function scaleImage(source: ImageData, width: number, height: number): ImageData {
    const from = canvas2d(source.width, source.height);
    from.putImageData(source, 0, 0);
    const to = canvas2d(width, height);
    to.imageSmoothingEnabled = true;
    to.drawImage(from.canvas, 0, 0, width, height);
    return to.getImageData(0, 0, width, height);
}

function toByte(value: number): number {
    return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Inpaint one model-sized tile. `image` is INPAINT_INPUT_SIZE square and
 * `hole` marks the pixels to fill with 1. The caller cuts the tile from the
 * page and pastes the answer back, so the model sees the text at (or near)
 * page resolution instead of a page squeezed into the square, where a thin
 * stroke falls out of the shrunken mask and the model paints it back.
 */
export async function inpaintTile(
    image: ImageData,
    hole: Uint8Array,
    fallback: [number, number, number] = [255, 255, 255],
): Promise<ImageData> {
    const size = INPAINT_INPUT_SIZE;
    if (image.width !== size || image.height !== size || hole.length !== size * size) {
        throw new Error(`An inpaint tile must be ${size} square.`);
    }
    const session = await loadSession();
    const inputName = session.inputNames[0];
    const maskName = session.inputNames[1] ?? session.inputNames[0];
    const plane = size * size;
    const input = new Float32Array(3 * plane);
    const holes = new Float32Array(plane);
    for (let index = 0; index < plane; index += 1) {
        const masked = hole[index] === 1;
        holes[index] = masked ? 1 : 0;
        const source = index * 4;
        for (let channel = 0; channel < 3; channel += 1) {
            input[channel * plane + index] = masked ? 0 : image.data[source + channel] / 127.5 - 1;
        }
    }
    const outputs = await session.run({
        [inputName]: new ort.Tensor('float32', input, [1, 3, size, size]),
        [maskName]: new ort.Tensor('float32', holes, [1, 1, size, size]),
    });
    const first = Object.values(outputs)[0] as ort.Tensor | undefined;
    if (!first || first.type !== 'float32' || !(first.data instanceof Float32Array)
        || first.data.length < plane * 3) {
        throw new Error('The inpaint model returned an unexpected tensor.');
    }
    const data = first.data;
    const decoded = new Uint8ClampedArray(plane * 4);
    for (let index = 0; index < plane; index += 1) {
        const offset = index * 4;
        const red = (data[index] + 1) * 127.5;
        const green = (data[plane + index] + 1) * 127.5;
        const blue = (data[2 * plane + index] + 1) * 127.5;
        decoded[offset] = Number.isFinite(red) ? toByte(red) : fallback[0];
        decoded[offset + 1] = Number.isFinite(green) ? toByte(green) : fallback[1];
        decoded[offset + 2] = Number.isFinite(blue) ? toByte(blue) : fallback[2];
        decoded[offset + 3] = 255;
    }
    return new ImageData(decoded, size, size);
}
