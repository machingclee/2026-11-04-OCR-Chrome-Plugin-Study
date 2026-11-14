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
function scaleImage(source: ImageData, width: number, height: number): ImageData {
    const from = canvas2d(source.width, source.height);
    from.putImageData(source, 0, 0);
    const to = canvas2d(width, height);
    to.imageSmoothingEnabled = true;
    to.drawImage(from.canvas, 0, 0, width, height);
    return to.getImageData(0, 0, width, height);
}

/**
 * Shrink the detector mask the way Shinobu does: paint ink white, scale with
 * smoothing, then keep a pixel only when it is still brighter than 127.
 */
function scaleMask(mask: Uint8Array, width: number, height: number, size: number): Uint8Array {
    const painted = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < mask.length; index += 1) {
        const offset = index * 4;
        const value = mask[index] === 1 ? 255 : 0;
        painted[offset] = value;
        painted[offset + 1] = value;
        painted[offset + 2] = value;
        painted[offset + 3] = 255;
    }
    const scaled = scaleImage(new ImageData(painted, width, height), size, size);
    const pooled = new Uint8Array(size * size);
    for (let index = 0; index < pooled.length; index += 1) {
        pooled[index] = scaled.data[index * 4] > 127 ? 1 : 0;
    }
    return pooled;
}

function toByte(value: number): number {
    return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Inpaint the page in one pass, matching the target project. The detector mask
 * and the page are both scaled into the 512 square. Holes are set to 0 after
 * the minus-one-to-one scale. The answer is scaled back and copied only onto
 * the full-resolution detector mask.
 *
 * `fallback` is the paper this pass is filling. A value the model cannot produce
 * (a NaN, which a broken kernel or a misread tensor leaves behind) becomes that
 * colour instead of the black a Uint8ClampedArray turns a NaN into.
 */
export async function inpaintPage(
    page: ImageData,
    mask: Uint8Array,
    fallback: [number, number, number] = [255, 255, 255],
): Promise<ImageData> {
    const size = INPAINT_INPUT_SIZE;
    const session = await loadSession();
    const inputName = session.inputNames[0];
    const maskName = session.inputNames[1] ?? session.inputNames[0];

    const scaled = scaleImage(page, size, size);
    const pooled = scaleMask(mask, page.width, page.height, size);
    const plane = size * size;
    const image = new Float32Array(3 * plane);
    const hole = new Float32Array(plane);

    for (let index = 0; index < plane; index += 1) {
        const masked = pooled[index] === 1;
        hole[index] = masked ? 1 : 0;
        const source = index * 4;
        for (let channel = 0; channel < 3; channel += 1) {
            image[channel * plane + index] = masked ? 0 : scaled.data[source + channel] / 127.5 - 1;
        }
    }

    const outputs = await session.run({
        [inputName]: new ort.Tensor('float32', image, [1, 3, size, size]),
        [maskName]: new ort.Tensor('float32', hole, [1, 1, size, size]),
    });

    // The decode below reads three float32 planes. A tensor of another type or
    // shape would read past its end, and an undefined value decodes as a NaN.
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

    const upscaled = scaleImage(new ImageData(decoded, size, size), page.width, page.height);
    const result = new Uint8ClampedArray(page.data);
    for (let index = 0; index < mask.length; index += 1) {
        if (mask[index] !== 1) continue;
        const offset = index * 4;
        result[offset] = upscaled.data[offset];
        result[offset + 1] = upscaled.data[offset + 1];
        result[offset + 2] = upscaled.data[offset + 2];
    }

    return new ImageData(result, page.width, page.height);
}
