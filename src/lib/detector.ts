import * as ort from 'onnxruntime-web/wasm';
import {
    DETECTOR_INPUT_SIZE,
    DETECTOR_MIN_AREA,
    DETECTOR_MIN_MEAN_SCORE,
    DETECTOR_MODEL_PATH,
    DETECTOR_SCORE_THRESHOLD,
    DETECTOR_UNCLIP_RATIO,
} from '../shared/constants';

ort.env.wasm.numThreads = 1;

import { foldAngle, minAreaRect } from './rect';
import type { Box, DetectionResult, Prepared, TextBlock } from './types';

let sessionPromise: Promise<ort.InferenceSession> | null = null;

export function isSessionReady(): boolean {
    return sessionPromise !== null;
}

export function loadDetector(): Promise<ort.InferenceSession> {
    if (!sessionPromise) {
        sessionPromise = ort.InferenceSession.create(chrome.runtime.getURL(DETECTOR_MODEL_PATH), {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
        }).catch((cause: unknown) => {
            sessionPromise = null;
            throw cause;
        });
    }
    return sessionPromise;
}

async function prepareInput(bitmap: ImageBitmap): Promise<Prepared> {
    const scale = Math.min(DETECTOR_INPUT_SIZE / bitmap.width, DETECTOR_INPUT_SIZE / bitmap.height);
    const drawWidth = Math.max(1, Math.round(bitmap.width * scale));
    const drawHeight = Math.max(1, Math.round(bitmap.height * scale));
    const padX = Math.floor((DETECTOR_INPUT_SIZE - drawWidth) / 2);
    const padY = Math.floor((DETECTOR_INPUT_SIZE - drawHeight) / 2);

    const canvas = new OffscreenCanvas(DETECTOR_INPUT_SIZE, DETECTOR_INPUT_SIZE);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No 2d context is available.');

    context.fillStyle = '#000';
    context.fillRect(0, 0, DETECTOR_INPUT_SIZE, DETECTOR_INPUT_SIZE);
    context.drawImage(bitmap, padX, padY, drawWidth, drawHeight);

    const { data } = context.getImageData(0, 0, DETECTOR_INPUT_SIZE, DETECTOR_INPUT_SIZE);
    const plane = DETECTOR_INPUT_SIZE * DETECTOR_INPUT_SIZE;
    const values = new Float32Array(plane * 3);
    for (let i = 0; i < plane; i += 1) {
        values[i] = data[i * 4] / 255;
        values[plane + i] = data[i * 4 + 1] / 255;
        values[plane * 2 + i] = data[i * 4 + 2] / 255;
    }

    return {
        tensor: new ort.Tensor('float32', values, [1, 3, DETECTOR_INPUT_SIZE, DETECTOR_INPUT_SIZE]),
        scale,
        padX,
        padY,
        width: bitmap.width,
        height: bitmap.height,
    };
}

/**
 * The model ships three maps: blk [1, N, 7] with block quads, seg with the
 * pixel mask used for erasing, and det with two channels whose first channel
 * holds the text lines. Read the det channel, because the seg mask separates
 * single glyphs and a crop of one glyph is not what OCR wants.
 */
function pickTextMap(outputs: Record<string, ort.Tensor>): Float32Array | null {
    const entries = Object.entries(outputs);
    const named = entries.find(([key]) => key.toLowerCase().includes('det'));
    const ordered = named ? [named, ...entries.filter(([key]) => key !== named[0])] : entries;

    const plane = DETECTOR_INPUT_SIZE * DETECTOR_INPUT_SIZE;
    for (const [, value] of ordered) {
        if (!(value instanceof ort.Tensor) || !(value.data instanceof Float32Array)) continue;
        const dims = value.dims;
        if (dims.length !== 4 || dims[0] !== 1 || dims[1] < 1) continue;
        if (dims[2] !== DETECTOR_INPUT_SIZE || dims[3] !== DETECTOR_INPUT_SIZE) continue;
        if (value.data.length < plane) continue;
        return value.data.subarray(0, plane);
    }
    return null;
}

/**
 * DBNet predicts a shrunken region, so every blob is widened before it counts as
 * a line. The offset comes from area over perimeter, which is what the reference
 * implementation calls unclip.
 */
function unclip(box: Box): Box {
    const area = box.width * box.height;
    const perimeter = 2 * (box.width + box.height);
    if (area <= 0 || perimeter <= 0) return box;

    const distance = (area * DETECTOR_UNCLIP_RATIO) / perimeter;
    return {
        x: box.x - distance,
        y: box.y - distance,
        width: box.width + distance * 2,
        height: box.height + distance * 2,
        score: box.score,
    };
}

function toDetBoxes(map: Float32Array, prepared: Prepared): Box[] {
    const size = DETECTOR_INPUT_SIZE;
    const visited = new Uint8Array(size * size);
    const boxes: Box[] = [];
    const stack: number[] = [];
    // The mask is walked once and every component keeps its own points, because a
    // slanted line needs a rectangle that follows the slant, not the page axes.
    const points: { x: number; y: number }[] = [];

    for (let start = 0; start < size * size; start += 1) {
        if (map[start] < DETECTOR_SCORE_THRESHOLD || visited[start]) continue;

        stack.push(start);
        visited[start] = 1;
        let minX = size;
        let minY = size;
        let maxX = -1;
        let maxY = -1;
        let count = 0;
        let sum = 0;
        points.length = 0;

        while (stack.length > 0) {
            const index = stack.pop() as number;
            const x = index % size;
            const y = (index - x) / size;
            count += 1;
            sum += map[index];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if ((count & 3) === 0) {
                points.push({
                    x: (x - prepared.padX) / prepared.scale,
                    y: (y - prepared.padY) / prepared.scale,
                });
            }

            for (let dy = -1; dy <= 1; dy += 1) {
                for (let dx = -1; dx <= 1; dx += 1) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
                    const next = ny * size + nx;
                    if (visited[next] || map[next] < DETECTOR_SCORE_THRESHOLD) continue;
                    visited[next] = 1;
                    stack.push(next);
                }
            }
        }

        if (count < DETECTOR_MIN_AREA) continue;
        const score = sum / count;
        if (score < DETECTOR_MIN_MEAN_SCORE) continue;

        const x = (minX - prepared.padX) / prepared.scale;
        const y = (minY - prepared.padY) / prepared.scale;
        const width = (maxX - minX + 1) / prepared.scale;
        const height = (maxY - minY + 1) / prepared.scale;

        const left = Math.max(0, x);
        const top = Math.max(0, y);
        const right = Math.min(prepared.width, x + width);
        const bottom = Math.min(prepared.height, y + height);
        if (right - left < 4 || bottom - top < 4) continue;

        const rect = minAreaRect(points);
        // The angle is stored as a deviation from the nearer page axis. A column
        // therefore gets an angle near zero, and the recogniser's own quarter
        // turn is not applied twice.
        let angle = rect ? foldAngle(rect.angle) : 0;
        if (angle > Math.PI / 4) angle -= Math.PI / 2;
        else if (angle <= -Math.PI / 4) angle += Math.PI / 2;

        boxes.push({
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
            score,
            angle,
            lineLength: rect ? rect.length : right - left,
            lineThickness: rect ? rect.thickness : bottom - top,
        });
    }

    const lines = boxes.map(unclip);
    lines.sort((a, b) => (Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x));
    return lines;
}

const BLOCK_SCORE = 0.35;
const BLOCK_NMS = 0.4;

function pickBlockTensor(outputs: Record<string, ort.Tensor>): ort.Tensor | null {
    const entries = Object.entries(outputs);
    const named = entries.find(([key]) => key.toLowerCase().includes('blk'));
    const ordered = named ? [named, ...entries.filter(([key]) => key !== named[0])] : entries;

    for (const [, value] of ordered) {
        if (!(value instanceof ort.Tensor)) continue;
        const dims = value.dims;
        if (dims.length === 3 && dims[2] >= 6) return value;
    }
    return null;
}

function intersectionOverUnion(a: TextBlock, b: TextBlock): number {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    if (right <= left || bottom <= top) return 0;
    const shared = (right - left) * (bottom - top);
    return shared / (a.width * a.height + b.width * b.height - shared);
}

/**
 * The blk output lists candidate text blocks as rows of (cx, cy, w, h, object, classes).
 * The result is a gate, not a source of geometry, and it also keeps the thin ruby
 * lines apart: a block covers a whole bubble, so a ruby column stays a separate
 * line for readingOrder.separateRuby to place on its host.
 */
function toBlkBoxes(tensor: ort.Tensor, prepared: Prepared): TextBlock[] {
    const data = tensor.data as Float32Array;
    const rows = tensor.dims[1] ?? 0;
    const columns = tensor.dims[2] ?? 0;
    const candidates: TextBlock[] = [];

    for (let row = 0; row < rows; row += 1) {
        const base = row * columns;
        const cx = data[base];
        const cy = data[base + 1];
        const width = data[base + 2];
        const height = data[base + 3];
        const objectness = data[base + 4];
        if (!Number.isFinite(cx + cy + width + height + objectness)) continue;

        let bestClass = 0;
        for (let index = 5; index < columns; index += 1) bestClass = Math.max(bestClass, data[base + index]);
        if (objectness * bestClass < BLOCK_SCORE) continue;

        const x = (cx - width / 2 - prepared.padX) / prepared.scale;
        const y = (cy - height / 2 - prepared.padY) / prepared.scale;
        const boxWidth = width / prepared.scale;
        const boxHeight = height / prepared.scale;
        if (boxWidth < 6 || boxHeight < 6) continue;
        if (boxWidth > prepared.width * 0.35 || boxHeight > prepared.height * 0.45) continue;

        candidates.push({
            x: Math.max(0, x),
            y: Math.max(0, y),
            width: Math.min(boxWidth, prepared.width - Math.max(0, x)),
            height: Math.min(boxHeight, prepared.height - Math.max(0, y)),
            score: objectness * bestClass,
        });
    }

    candidates.sort((a, b) => b.score - a.score);
    const kept: TextBlock[] = [];
    for (const candidate of candidates) {
        if (kept.every((block) => intersectionOverUnion(candidate, block) < BLOCK_NMS)) kept.push(candidate);
    }
    return kept;
}

function pickSegMask(outputs: Record<string, ort.Tensor>): Float32Array | null {
    const entries = Object.entries(outputs);
    const named = entries.find(([key]) => key.toLowerCase().includes('seg'));
    const ordered = named ? [named, ...entries.filter(([key]) => key !== named[0])] : entries;
    const plane = DETECTOR_INPUT_SIZE * DETECTOR_INPUT_SIZE;

    for (const [, value] of ordered) {
        if (!(value instanceof ort.Tensor) || !(value.data instanceof Float32Array)) continue;
        const dims = value.dims;
        if (dims.length !== 4 || dims[0] !== 1 || dims[1] !== 1) continue;
        if (value.data.length < plane) continue;
        return value.data.subarray(0, plane);
    }
    return null;
}

export async function detectBoxes(bitmap: ImageBitmap): Promise<DetectionResult> {
    const session = await loadDetector();
    const inputName = session.inputNames[0];
    if (!inputName) throw new Error('The detector exposes no input.');

    const prepared = await prepareInput(bitmap);
    const outputs = await session.run({ [inputName]: prepared.tensor });
    const typed = outputs as Record<string, ort.Tensor>;
    const map = pickTextMap(typed);
    if (!map) throw new Error('The detector returned no score map.');

    const blockTensor = pickBlockTensor(typed);
    const seg = pickSegMask(typed);
    return {
        detBoxes: toDetBoxes(map, prepared),
        blkBoxes: blockTensor ? toBlkBoxes(blockTensor, prepared) : [],
        mask: seg ? { data: seg, scale: prepared.scale, padX: prepared.padX, padY: prepared.padY } : null,
    };
}
