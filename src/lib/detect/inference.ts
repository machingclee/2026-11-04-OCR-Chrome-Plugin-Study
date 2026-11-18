import * as ort from 'onnxruntime-web/webgpu';
import {
    DETECTOR_INPUT_SIZE,
    DETECTOR_MODEL_PATH,
} from '../../shared/constants';
import { hasSession, runSession, sessionFor } from '../onnx';
import type { Prepared } from '../types';

export type DetectorRun = {
    /** Channel 0 of the det head: one band per text line. */
    det: Float32Array;
    /** The seg head: one mask per glyph stroke. Null when the export has none. */
    seg: Float32Array | null;
    /** The block head: large text regions, in page pixels. */
    blocks: DetectedBlock[];
    /** The letterboxed tensor plus the numbers needed to reach map pixels. */
    prepared: Prepared;
};

export type DetectedBlock = {
    x: number;
    y: number;
    width: number;
    height: number;
    score: number;
};

export function isSessionReady(): boolean {
    return hasSession('detector');
}

/** Load the detector once per page; a failed load is retried on the next pick. */
export function loadDetector(): Promise<ort.InferenceSession> {
    return sessionFor('detector', chrome.runtime.getURL(DETECTOR_MODEL_PATH), 'detector');
}

type PixelSource = ImageBitmap | HTMLCanvasElement;

/**
 * Letterbox the page into the 1024 square. The image is centred and the rest of
 * the tile is black, which is what the detector saw during training.
 */
async function prepareInput(bitmap: PixelSource): Promise<Prepared> {
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
 * The model ships three maps: blk with block quads, seg with the inpainting mask,
 * and det with two channels whose first channel holds one band per text line.
 * Only the first channel is read here.
 */
function pickDet(outputs: Record<string, ort.Tensor>): Float32Array | null {
    const plane = DETECTOR_INPUT_SIZE * DETECTOR_INPUT_SIZE;
    const entries = Object.entries(outputs);
    const named = entries.find(([key]) => key.toLowerCase().includes('det'));
    const ordered = named ? [named, ...entries.filter(([key]) => key !== named[0])] : entries;

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

function pickSeg(outputs: Record<string, ort.Tensor>): Float32Array | null {
    const plane = DETECTOR_INPUT_SIZE * DETECTOR_INPUT_SIZE;
    const entries = Object.entries(outputs);
    const named = entries.find(([key]) => key.toLowerCase().includes('seg'));
    const ordered = named ? [named, ...entries.filter(([key]) => key !== named[0])] : entries;

    for (const [, value] of ordered) {
        if (!(value instanceof ort.Tensor) || !(value.data instanceof Float32Array)) continue;
        const dims = value.dims;
        if (dims.length !== 4 || dims[0] !== 1 || dims[1] !== 1) continue;
        if (value.data.length < plane) continue;
        return value.data.subarray(0, plane);
    }
    return null;
}

function pickBlk(outputs: Record<string, ort.Tensor>): ort.Tensor | null {
    const byName = outputs.blk;
    if (byName && byName.dims.length === 3 && byName.dims[2] >= 6) return byName;
    for (const value of Object.values(outputs)) {
        if (value.dims.length === 3 && value.dims[2] >= 6) return value;
    }
    return null;
}

function overlap(a: DetectedBlock, b: DetectedBlock): number {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    if (right <= left || bottom <= top) return 0;
    const shared = (right - left) * (bottom - top);
    return shared / (a.width * a.height + b.width * b.height - shared);
}

/**
 * The block head answers with rows of cx, cy, w, h, objectness and one score per
 * class, in the letterboxed map. Decode them to page pixels so the debug view
 * can draw what the model considers a text region.
 */
function readBlocks(outputs: Record<string, ort.Tensor>, prepared: Prepared): DetectedBlock[] {
    const tensor = pickBlk(outputs);
    if (!tensor || !(tensor.data instanceof Float32Array)) return [];
    const rows = tensor.dims[1] ?? 0;
    const cols = tensor.dims[2] ?? 0;
    if (rows <= 0 || cols < 6) return [];

    const data = tensor.data;
    const candidates: DetectedBlock[] = [];
    for (let row = 0; row < rows; row += 1) {
        const base = row * cols;
        const centreX = data[base];
        const centreY = data[base + 1];
        const width = data[base + 2];
        const height = data[base + 3];
        const objectness = data[base + 4];
        if (!Number.isFinite(centreX + centreY + width + height + objectness)) continue;
        let best = 1;
        for (let column = 5; column < cols; column += 1) {
            best = Math.max(best, data[base + column]);
        }
        const score = objectness * best;
        if (score < 0.35) continue;
        if (width < 6 || height < 6) continue;

        const x = (centreX - width / 2 - prepared.padX) / prepared.scale;
        const y = (centreY - height / 2 - prepared.padY) / prepared.scale;
        const boxWidth = width / prepared.scale;
        const boxHeight = height / prepared.scale;
        if (boxWidth < 6 || boxHeight < 6) continue;
        if (boxWidth * boxHeight > prepared.width * prepared.height * 0.25) continue;
        const left = Math.max(0, x);
        const top = Math.max(0, y);
        const right = Math.min(prepared.width, x + boxWidth);
        const bottom = Math.min(prepared.height, y + boxHeight);
        if (right - left < 6 || bottom - top < 6) continue;
        candidates.push({ x: left, y: top, width: right - left, height: bottom - top, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    const kept: DetectedBlock[] = [];
    for (const candidate of candidates) {
        if (kept.some((other) => overlap(candidate, other) >= 0.35)) continue;
        kept.push(candidate);
        if (kept.length >= 96) break;
    }
    return kept;
}

/** One detector pass: the two score maps and the letterbox that produced them. */
export async function runDetector(bitmap: PixelSource): Promise<DetectorRun> {
    const session = await loadDetector();
    const inputName = session.inputNames[0];
    if (!inputName) throw new Error('The detector exposes no input.');

    const prepared = await prepareInput(bitmap);
    const outputs = await runSession(session, { [inputName]: prepared.tensor }, 'detector');
    const det = pickDet(outputs);
    if (!det) throw new Error('The detector returned no score map.');
    return { det, seg: pickSeg(outputs), blocks: readBlocks(outputs, prepared), prepared };
}
