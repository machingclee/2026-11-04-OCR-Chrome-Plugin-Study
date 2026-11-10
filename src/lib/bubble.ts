import * as ort from 'onnxruntime-web/wasm';
import {
    BUBBLE_INPUT_SIZE,
    BUBBLE_MASK_THRESHOLD,
    BUBBLE_MODEL_PATH,
    BUBBLE_NMS,
    BUBBLE_SCORE_THRESHOLD,
} from '../shared/constants';
import type { BubbleMask, Box } from './types';

if (ort.env?.wasm) ort.env.wasm.numThreads = 1;

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function loadBubble(): Promise<ort.InferenceSession> {
    if (!sessionPromise) {
        sessionPromise = ort.InferenceSession.create(chrome.runtime.getURL(BUBBLE_MODEL_PATH), {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
        });
    }
    return sessionPromise;
}

export function isBubbleReady(): boolean {
    return sessionPromise !== null;
}

function intersectionOverUnion(a: Box, b: Box): number {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    if (right <= left || bottom <= top) return 0;
    const shared = (right - left) * (bottom - top);
    return shared / (a.width * a.height + b.width * b.height - shared);
}

/**
 * The bubble head is a YOLOv8 segmentation export with one class. Each of the
 * 8400 anchors carries a box, one confidence, and 32 mask coefficients that the
 * prototypes turn into a mask.
 */
export async function detectBubbles(bitmap: ImageBitmap): Promise<BubbleMask> {
    const session = await loadBubble();
    const inputName = session.inputNames[0];
    if (!inputName) throw new Error('The bubble model exposes no input.');

    const size = BUBBLE_INPUT_SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The browser refused a 2D context for the bubbles.');
    context.fillStyle = '#000';
    context.fillRect(0, 0, size, size);

    const scale = Math.min(size / bitmap.width, size / bitmap.height);
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const padX = Math.floor((size - width) / 2);
    const padY = Math.floor((size - height) / 2);
    context.drawImage(bitmap, padX, padY, width, height);

    const pixels = context.getImageData(0, 0, size, size).data;
    const tensor = new Float32Array(3 * size * size);
    for (let index = 0; index < size * size; index += 1) {
        const offset = index * 4;
        tensor[index] = pixels[offset] / 255;
        tensor[size * size + index] = pixels[offset + 1] / 255;
        tensor[size * size * 2 + index] = pixels[offset + 2] / 255;
    }

    const outputs = await session.run({ [inputName]: new ort.Tensor('float32', tensor, [1, 3, size, size]) });
    const values = Object.values(outputs) as ort.Tensor[];
    const detection = values.find((value) => value.dims.length === 3 && value.dims[1] < value.dims[2]);
    const prototypes = values.find((value) => value.dims.length === 4);
    if (!detection || !prototypes) throw new Error('The bubble model returned unexpected outputs.');

    const anchors = detection.dims[2];
    const rows = detection.dims[1];
    const data = detection.data as Float32Array;
    const confidenceOffset = 4;
    const coefficientOffset = 5;
    const coefficientCount = rows - coefficientOffset;

    const candidates: { box: Box; score: number; index: number }[] = [];
    for (let index = 0; index < anchors; index += 1) {
        const score = data[confidenceOffset * anchors + index];
        if (score < BUBBLE_SCORE_THRESHOLD) continue;
        const cx = data[index];
        const cy = data[anchors + index];
        const width = data[anchors * 2 + index];
        const height = data[anchors * 3 + index];
        candidates.push({
            box: { x: cx - width / 2, y: cy - height / 2, width, height, score },
            score,
            index,
        });
    }

    candidates.sort((a, b) => b.score - a.score);
    const kept: typeof candidates = [];
    for (const candidate of candidates) {
        if (kept.every((other) => intersectionOverUnion(candidate.box, other.box) < BUBBLE_NMS)) kept.push(candidate);
    }

    const prototypeData = prototypes.data as Float32Array;
    const prototypeSize = prototypes.dims[3];
    const mask = new Float32Array(size * size);

    for (const { index } of kept) {
        for (let y = 0; y < size; y += 1) {
            for (let x = 0; x < size; x += 1) {
                const px = Math.floor((x * prototypeSize) / size);
                const py = Math.floor((y * prototypeSize) / size);
                let sum = 0;
                for (let c = 0; c < coefficientCount; c += 1) {
                    const coefficient = data[(coefficientOffset + c) * anchors + index];
                    sum += coefficient * prototypeData[c * prototypeSize * prototypeSize + py * prototypeSize + px];
                }
                const value = 1 / (1 + Math.exp(-sum));
                if (value > BUBBLE_MASK_THRESHOLD && value > mask[y * size + x]) mask[y * size + x] = value;
            }
        }
    }

    return { data: mask, scale, padX, padY, size };
}
