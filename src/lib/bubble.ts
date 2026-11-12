import * as ort from 'onnxruntime-web/webgpu';
import {
    BUBBLE_INPUT_SIZE,
    BUBBLE_MASK_THRESHOLD,
    BUBBLE_MODEL_PATH,
    BUBBLE_NMS,
    BUBBLE_SCORE_THRESHOLD,
} from '../shared/constants';
import type { Bubble, BubbleMask, Box } from './types';

if (ort.env?.wasm) ort.env.wasm.numThreads = 1;

const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator;

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function loadBubble(): Promise<ort.InferenceSession> {
    if (!sessionPromise) {
        sessionPromise = ort.InferenceSession.create(chrome.runtime.getURL(BUBBLE_MODEL_PATH), {
            executionProviders: webgpu ? ['webgpu', 'wasm'] : ['wasm'],
            graphOptimizationLevel: 'all',
        }).catch(async (cause: unknown) => {
            if (!webgpu) throw cause;
            console.warn('WebGPU bubble model failed, using WASM.', cause);
            return ort.InferenceSession.create(chrome.runtime.getURL(BUBBLE_MODEL_PATH), {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'all',
            });
        });
    }
    void sessionPromise.then(() => console.info(`Bubble provider: ${webgpu ? 'webgpu preferred' : 'wasm'}`));
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
/** Walk the mask outward on a few rays, so the shape becomes a small polygon. */
function outlineOf(shape: Float32Array, size: number, scale: number, padX: number, padY: number, model: number) {
    const points: { x: number; y: number }[] = [];
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            if (shape[y * size + x] <= 0.5) continue;
            sumX += x;
            sumY += y;
            count += 1;
        }
    }
    if (count === 0) return points;

    const centreX = sumX / count;
    const centreY = sumY / count;
    const rays = 24;
    for (let ray = 0; ray < rays; ray += 1) {
        const angle = (ray / rays) * Math.PI * 2;
        const stepX = Math.cos(angle);
        const stepY = Math.sin(angle);
        let furthest = 0;
        for (let radius = 1; radius < size; radius += 1) {
            const x = Math.round(centreX + stepX * radius);
            const y = Math.round(centreY + stepY * radius);
            if (x < 0 || y < 0 || x >= size || y >= size) break;
            if (shape[y * size + x] > 0.5) furthest = radius;
        }
        const x = centreX + stepX * furthest;
        const y = centreY + stepY * furthest;
        const modelX = (x / size) * model;
        const modelY = (y / size) * model;
        points.push({ x: (modelX - padX) / scale, y: (modelY - padY) / scale });
    }
    return points;
}

export async function detectBubbles(bitmap: ImageBitmap): Promise<{ mask: BubbleMask; bubbles: Bubble[] }> {
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

    const shapes: Float32Array[] = [];

    for (const { index } of kept) {
        // One mask per balloon at prototype resolution: it says where the balloon
        // really is, which a box cannot, and it costs 25 KB instead of 1.6 MB.
        const shape = new Float32Array(prototypeSize * prototypeSize);
        for (let y = 0; y < prototypeSize; y += 1) {
            for (let x = 0; x < prototypeSize; x += 1) {
                let sum = 0;
                for (let c = 0; c < coefficientCount; c += 1) {
                    const coefficient = data[(coefficientOffset + c) * anchors + index];
                    sum += coefficient * prototypeData[c * prototypeSize * prototypeSize + y * prototypeSize + x];
                }
                shape[y * prototypeSize + x] = 1 / (1 + Math.exp(-sum));
            }
        }
        shapes.push(shape);
    }

    for (const shape of shapes) {
        for (let y = 0; y < size; y += 1) {
            for (let x = 0; x < size; x += 1) {
                const px = Math.floor((x * prototypeSize) / size);
                const py = Math.floor((y * prototypeSize) / size);
                const value = shape[py * prototypeSize + px];
                if (value > BUBBLE_MASK_THRESHOLD && value > mask[y * size + x]) mask[y * size + x] = value;
            }
        }
    }

    const bubbles: Bubble[] = kept.map((candidate, id) => ({
        id,
        x: (candidate.box.x - padX) / scale,
        y: (candidate.box.y - padY) / scale,
        width: candidate.box.width / scale,
        height: candidate.box.height / scale,
        score: candidate.score,
        outline: outlineOf(shapes[id], prototypeSize, scale, padX, padY, size),
        shape: shapes[id],
        shapeSize: prototypeSize,
        shapeScale: scale,
        shapePadX: padX,
        shapePadY: padY,
    }));

    return { mask: { data: mask, scale, padX, padY, size }, bubbles };
}
