import * as ort from 'onnxruntime-web/wasm';
import { INPAINT_INPUT_SIZE, INPAINT_MASK_NAME, INPAINT_MODEL_PATH } from '../shared/constants';
import { eraseGlyphs } from './erase';
import type { Box, BubbleMask, TextMask } from './types';

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function loadInpaint(): Promise<ort.InferenceSession> {
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
 * The bubble mask protects the outline: a glyph pixel outside every bubble keeps
 * its original value, so the inpaint model never repaints the border.
 */
function insideBubble(bubbles: BubbleMask, box: Box, x: number, y: number, size: number): boolean {
    const pageX = box.x + ((x + 0.5) * box.width) / size;
    const pageY = box.y + ((y + 0.5) * box.height) / size;
    const sourceX = Math.round(pageX * bubbles.scale + bubbles.padX);
    const sourceY = Math.round(pageY * bubbles.scale + bubbles.padY);
    if (sourceX < 0 || sourceY < 0 || sourceX >= bubbles.size || sourceY >= bubbles.size) return false;
    return bubbles.data[sourceY * bubbles.size + sourceX] > 0.5;
}

/**
 * AOT-GAN removes what the mask marks. The crop goes in at 512 square, the model
 * answers in the same shape, and only the masked pixels come back out, so the
 * rest of the bubble keeps its original pixels.
 */
export async function inpaintBox(
    bitmap: ImageBitmap,
    box: Box,
    mask: TextMask,
    bubbles?: BubbleMask,
): Promise<string> {
    const size = INPAINT_INPUT_SIZE;
    const session = await loadInpaint();
    const imageName = session.inputNames[0];
    if (!imageName) throw new Error('The inpaint model exposes no image input.');

    const source = document.createElement('canvas');
    source.width = size;
    source.height = size;
    const sourceContext = source.getContext('2d');
    if (!sourceContext) throw new Error('The browser refused a 2D context for the inpaint.');
    sourceContext.drawImage(bitmap, box.x, box.y, box.width, box.height, 0, 0, size, size);

    const original = sourceContext.getImageData(0, 0, size, size);
    const pixels = original.data;

    const glyphMask = new ImageData(new Uint8ClampedArray(pixels), size, size);
    eraseGlyphs(glyphMask, box, mask);
    const erased = glyphMask.data;

    const image = new Float32Array(3 * size * size);
    const maskTensor = new Float32Array(size * size);
    for (let index = 0; index < size * size; index += 1) {
        const offset = index * 4;
        image[index] = (pixels[offset] / 127.5) - 1;
        image[size * size + index] = (pixels[offset + 1] / 127.5) - 1;
        image[size * size * 2 + index] = (pixels[offset + 2] / 127.5) - 1;
        let changed = pixels[offset] !== erased[offset] || pixels[offset + 1] !== erased[offset + 1]
            || pixels[offset + 2] !== erased[offset + 2];
        if (changed && bubbles) changed = insideBubble(bubbles, box, index % size, Math.floor(index / size), size);
        maskTensor[index] = changed ? 1 : 0;
    }

    const outputs = await session.run({
        [imageName]: new ort.Tensor('float32', image, [1, 3, size, size]),
        [INPAINT_MASK_NAME]: new ort.Tensor('float32', maskTensor, [1, 1, size, size]),
    });

    const output = Object.values(outputs)[0] as ort.Tensor;
    const result = output.data as Float32Array;
    const filled = new ImageData(size, size);
    for (let index = 0; index < size * size; index += 1) {
        const offset = index * 4;
        const keepMask = maskTensor[index] > 0.5;
        for (let channel = 0; channel < 3; channel += 1) {
            const value = result[channel * size * size + index];
            const byte = Math.max(0, Math.min(255, Math.round((value + 1) * 127.5)));
            filled.data[offset + channel] = keepMask ? byte : pixels[offset + channel];
        }
        filled.data[offset + 3] = 255;
    }

    const target = document.createElement('canvas');
    target.width = size;
    target.height = size;
    const targetContext = target.getContext('2d');
    if (!targetContext) throw new Error('The browser refused a 2D context for the inpainted crop.');
    targetContext.putImageData(filled, 0, 0);
    return target.toDataURL('image/webp', 0.8);
}
