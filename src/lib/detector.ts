import * as ort from 'onnxruntime-web/webgpu';
import {
    DETECTOR_INPUT_SIZE,
    DETECTOR_MIN_AREA,
    DETECTOR_MIN_MEAN_SCORE,
    DETECTOR_MODEL_PATH,
    DETECTOR_SCORE_THRESHOLD,
    DETECTOR_UNCLIP_RATIO,
} from '../shared/constants';

ort.env.wasm.numThreads = 1;

const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator;

import { foldAngle, mainCluster, majorAxis, minAreaRect } from './rect';
import type { Box, DetectionResult, Prepared, TextBlock } from './types';

let sessionPromise: Promise<ort.InferenceSession> | null = null;

export function isSessionReady(): boolean {
    return sessionPromise !== null;
}

export function loadDetector(): Promise<ort.InferenceSession> {
    if (!sessionPromise) {
        sessionPromise = ort.InferenceSession.create(chrome.runtime.getURL(DETECTOR_MODEL_PATH), {
            executionProviders: webgpu ? ['webgpu', 'wasm'] : ['wasm'],
            graphOptimizationLevel: 'all',
        }).catch(async (cause: unknown) => {
            if (!webgpu) {
                sessionPromise = null;
                throw cause;
            }
            console.warn('WebGPU detector failed, using WASM.', cause);
            try {
                return await ort.InferenceSession.create(chrome.runtime.getURL(DETECTOR_MODEL_PATH), {
                    executionProviders: ['wasm'],
                    graphOptimizationLevel: 'all',
                });
            } catch (fallbackCause) {
                sessionPromise = null;
                throw fallbackCause;
            }
        });
    }
    void sessionPromise.then(() => console.info(`Detector provider: ${webgpu ? 'webgpu preferred' : 'wasm'}`));
    return sessionPromise;
}

type PixelSource = ImageBitmap | HTMLCanvasElement;

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
        angle: box.angle,
        // The rotated box has to grow with the axis aligned one, or the drawn
        // box and the crop disagree about how thick the line is.
        lineLength: box.lineLength === undefined ? undefined : box.lineLength + distance * 2,
        lineThickness: box.lineThickness === undefined ? undefined : box.lineThickness + distance * 2,
    };
}

type Group = { pixels: number[]; minX: number; maxX: number; minY: number; maxY: number };

/** Cut a component wherever the projection drops, so touching columns split. */
function splitByProfile(pixels: number[], alongX: boolean): Group[] {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let index = 0; index < pixels.length; index += 2) {
        const x = pixels[index];
        const y = pixels[index + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }

    const span = alongX ? maxX - minX + 1 : maxY - minY + 1;
    const histogram = new Int32Array(span);
    for (let index = 0; index < pixels.length; index += 2) {
        const position = alongX ? pixels[index] - minX : pixels[index + 1] - minY;
        histogram[position] += 1;
    }

    let peak = 0;
    for (const value of histogram) if (value > peak) peak = value;
    if (peak === 0) return [{ pixels, minX, maxX, minY, maxY }];

    const cuts: number[] = [];
    let run = 0;
    for (let position = 0; position < span; position += 1) {
        if (histogram[position] <= peak * 0.15) {
            run += 1;
            continue;
        }
        if (run >= 2) cuts.push(position - run);
        run = 0;
    }

    if (cuts.length === 0) return [{ pixels, minX, maxX, minY, maxY }];

    const buckets = new Map<number, number[]>();
    for (let index = 0; index < pixels.length; index += 2) {
        const position = alongX ? pixels[index] : pixels[index + 1];
        let bucket = 0;
        while (bucket < cuts.length && position >= cuts[bucket]) bucket += 1;
        const list = buckets.get(bucket);
        if (list) list.push(pixels[index], pixels[index + 1]);
        else buckets.set(bucket, [pixels[index], pixels[index + 1]]);
    }

    const groups: Group[] = [];
    for (const list of buckets.values()) {
        if (list.length < 40) continue;
        let gMinX = Infinity;
        let gMaxX = -Infinity;
        let gMinY = Infinity;
        let gMaxY = -Infinity;
        for (let index = 0; index < list.length; index += 2) {
            const x = list[index];
            const y = list[index + 1];
            if (x < gMinX) gMinX = x;
            if (x > gMaxX) gMaxX = x;
            if (y < gMinY) gMinY = y;
            if (y > gMaxY) gMaxY = y;
        }
        groups.push({ pixels: list, minX: gMinX, maxX: gMaxX, minY: gMinY, maxY: gMaxY });
    }

    return groups.length > 0 ? groups : [{ pixels, minX, maxX, minY, maxY }];
}

/** Measure one group and push the box the rest of the pipeline expects. */
function emitBox(group: Group, prepared: Prepared, boxes: Box[], score: number): void {
    const x = (group.minX - prepared.padX) / prepared.scale;
    const y = (group.minY - prepared.padY) / prepared.scale;
    const width = (group.maxX - group.minX + 1) / prepared.scale;
    const height = (group.maxY - group.minY + 1) / prepared.scale;

    const left = Math.max(0, x);
    const top = Math.max(0, y);
    const right = Math.min(prepared.width, x + width);
    const bottom = Math.min(prepared.height, y + height);
    if (right - left < 4 || bottom - top < 4) return;

    const points: { x: number; y: number }[] = [];
    for (let index = 0; index < group.pixels.length; index += 8) {
        points.push({
            x: (group.pixels[index] - prepared.padX) / prepared.scale,
            y: (group.pixels[index + 1] - prepared.padY) / prepared.scale,
        });
    }

    const hull = boxFromDetHull(points, score, prepared);
    if (hull) {
        boxes.push(hull);
        return;
    }
    boxes.push({
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        score,
    });
}

function toDetBoxes(map: Float32Array, prepared: Prepared): Box[] {
    const size = DETECTOR_INPUT_SIZE;
    const visited = new Uint8Array(size * size);
    const boxes: Box[] = [];
    const stack: number[] = [];
    // The mask is walked once and every component keeps its own points, because a
    // slanted line needs a rectangle that follows the slant, not the page axes.
    const pixels: number[] = [];

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
        pixels.length = 0;

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
            pixels.push(x, y);

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

        const aabbArea = (maxX - minX + 1) * (maxY - minY + 1);
        if (maskFill(pixels, count, aabbArea) < DETECTOR_MIN_FILL) continue;

        // Two columns of one bubble can touch inside the det map. The projection
        // profile has a valley between them, so the component is split there and
        // every group is measured on its own.
        const groups = splitByProfile(pixels, maxX - minX >= maxY - minY);
        for (const group of groups) emitBox(group, prepared, boxes, score);
    }

    // These are the shrunken cores. Widening waits until the seg plane can say
    // which cores belong to one line, so a gap is not filled before that choice.
    boxes.sort((a, b) => (Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x));
    return boxes;
}

/**
 * A line of text fills most of its tight rectangle. The page-aligned box is the
 * wrong measure: a leaned line leaves empty corners there and looks as empty as
 * a panel border. The border stays empty inside its own tight rectangle.
 */
const DETECTOR_MIN_FILL = 0.35;

/** Share of the minimum rectangle that the mask fills. Falls back to the page box. */
function maskFill(pixels: number[], count: number, aabbArea: number): number {
    const points: { x: number; y: number }[] = [];
    for (let index = 0; index < pixels.length; index += 2) {
        points.push({ x: pixels[index], y: pixels[index + 1] });
    }
    const rect = minAreaRect(points);
    const tight = rect ? rect.length * rect.thickness : 0;
    const area = tight > 0 ? tight : aabbArea;
    return area > 0 ? count / area : 0;
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
        // The target project drops a very wide block, which is usually a border.
        if (boxWidth / boxHeight > 1.8) continue;
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

/**
 * The det map sometimes misses a whole column in a dense balloon, while seg still
 * marks every stroke. Those strokes are merged into line sized boxes and added as
 * a second source, which the target project does when its block head is empty.
 */
function toSegBoxes(seg: Float32Array, prepared: Prepared): Box[] {
    const size = DETECTOR_INPUT_SIZE;
    const visited = new Uint8Array(size * size);
    const clusters: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const stack: number[] = [];

    for (let start = 0; start < size * size; start += 1) {
        if (seg[start] < 0.46 || visited[start]) continue;
        stack.push(start);
        visited[start] = 1;
        let count = 0;
        let x0 = size;
        let y0 = size;
        let x1 = -1;
        let y1 = -1;
        while (stack.length > 0) {
            const index = stack.pop() as number;
            const x = index % size;
            const y = (index - x) / size;
            count += 1;
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x > x1) x1 = x;
            if (y > y1) y1 = y;
            for (let dy = -1; dy <= 1; dy += 1) {
                for (let dx = -1; dx <= 1; dx += 1) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
                    const next = ny * size + nx;
                    if (visited[next] || seg[next] < 0.46) continue;
                    visited[next] = 1;
                    stack.push(next);
                }
            }
        }
        if (count < 16) continue;
        clusters.push({ x0, y0, x1, y1 });
    }

    // Join clusters that sit within a few pixels of each other, so the glyphs of
    // one column become one box instead of ten.
    const gap = Math.max(4, Math.round(size / 200));
    const boxes: Box[] = [];
    for (const cluster of clusters) {
        let merged = { ...cluster };
        let changed = true;
        while (changed) {
            changed = false;
            for (let index = 0; index < clusters.length; index += 1) {
                const other = clusters[index];
                if (other === null) continue;
                const near = merged.x0 - gap <= other.x1 && other.x0 - gap <= merged.x1
                    && merged.y0 - gap <= other.y1 && other.y0 - gap <= merged.y1;
                if (!near) continue;
                merged = {
                    x0: Math.min(merged.x0, other.x0),
                    y0: Math.min(merged.y0, other.y0),
                    x1: Math.max(merged.x1, other.x1),
                    y1: Math.max(merged.y1, other.y1),
                };
                clusters[index] = null as unknown as { x0: number; y0: number; x1: number; y1: number };
                changed = true;
            }
        }

        const x = (merged.x0 - prepared.padX) / prepared.scale;
        const y = (merged.y0 - prepared.padY) / prepared.scale;
        const width = (merged.x1 - merged.x0 + 1) / prepared.scale;
        const height = (merged.y1 - merged.y0 + 1) / prepared.scale;
        if (width < 8 || height < 8) continue;
        if (width / height > 6 || height / width > 12) continue;
        boxes.push({
            x: Math.max(0, x),
            y: Math.max(0, y),
            width,
            height,
            score: 0.9,
            angle: 0,
        });
    }
    return boxes;
}

type SegPart = {
    points: { x: number; y: number }[];
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    cx: number;
    cy: number;
};

/** Empty run, in page pixels, after which the det line has ended. */
const DET_LINE_GAP = 16;
/**
 * Italic strokes lean off the column. A sentence this close to an axis is that
 * column, and the box sits on the axis instead of following the stroke.
 */
const UPRIGHT_LIMIT = (20 * Math.PI) / 180;

function medianOf(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Large reaches barely move this, so one fat blob cannot set the column width. */
function harmonicMean(values: number[]): number {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const value of values) sum += 1 / Math.max(value, 1);
    return values.length / sum;
}

/** Snap a near-vertical or near-horizontal sentence onto that axis. */
function uprightAngle(angle: number): number {
    const folded = foldAngle(angle);
    const toVertical = Math.abs(Math.abs(folded) - Math.PI / 2);
    const toHorizontal = Math.abs(folded);
    if (toVertical <= UPRIGHT_LIMIT && toVertical <= toHorizontal) return Math.PI / 2;
    if (toHorizontal <= UPRIGHT_LIMIT) return 0;
    return angle;
}

/** Seg components about one character wide, in page pixels. */
function segParts(seg: Float32Array, prepared: Prepared): SegPart[] {
    const size = DETECTOR_INPUT_SIZE;
    const visited = new Uint8Array(size * size);
    const parts: SegPart[] = [];
    const stack: number[] = [];
    const samples: number[] = [];

    for (let start = 0; start < size * size; start += 1) {
        if (seg[start] < 0.46 || visited[start]) continue;
        stack.push(start);
        visited[start] = 1;
        samples.length = 0;
        let count = 0;
        let x0 = size;
        let y0 = size;
        let x1 = -1;
        let y1 = -1;
        while (stack.length > 0) {
            const index = stack.pop() as number;
            const x = index % size;
            const y = (index - x) / size;
            count += 1;
            if ((count & 3) === 0) samples.push(x, y);
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x > x1) x1 = x;
            if (y > y1) y1 = y;
            for (let dy = -1; dy <= 1; dy += 1) {
                for (let dx = -1; dx <= 1; dx += 1) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
                    const next = ny * size + nx;
                    if (visited[next] || seg[next] < 0.46) continue;
                    visited[next] = 1;
                    stack.push(next);
                }
            }
        }
        if (count < 16) continue;
        const minX = (x0 - prepared.padX) / prepared.scale;
        const minY = (y0 - prepared.padY) / prepared.scale;
        const maxX = (x1 + 1 - prepared.padX) / prepared.scale;
        const maxY = (y1 + 1 - prepared.padY) / prepared.scale;
        const width = maxX - minX;
        const height = maxY - minY;
        if (Math.min(width, height) < 6 || Math.max(width, height) > 220) continue;

        const stride = Math.max(1, Math.floor(samples.length / 60));
        const points: { x: number; y: number }[] = [];
        for (let index = 0; index < samples.length; index += stride * 2) {
            points.push({
                x: (samples[index] - prepared.padX) / prepared.scale,
                y: (samples[index + 1] - prepared.padY) / prepared.scale,
            });
        }
        parts.push({ points, minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 });
    }
    return parts;
}

/** Principal axis of the main cluster. Thickness is how wide that cluster is. */
function longAxis(points: { x: number; y: number }[]): { angle: number; thickness: number } | null {
    const cluster = mainCluster(points);
    if (!cluster) return null;
    const acrossX = -Math.sin(cluster.angle);
    const acrossY = Math.cos(cluster.angle);
    let min = Infinity;
    let max = -Infinity;
    for (const point of cluster.points) {
        const across = point.x * acrossX + point.y * acrossY;
        if (across < min) min = across;
        if (across > max) max = across;
    }
    return { angle: cluster.angle, thickness: Math.max(1, max - min) };
}

function overlapsCore(part: SegPart, box: Box, margin: number): boolean {
    return part.minX <= box.x + box.width + margin
        && part.maxX >= box.x - margin
        && part.minY <= box.y + box.height + margin
        && part.maxY >= box.y - margin;
}

function centreInside(box: Box, x: number, y: number): boolean {
    return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
}

/**
 * SEG part centres of one straight line sit on it. A gap on the minor axis is
 * another line. A side blob that is not itself a line stays out.
 */
function columnGroups(members: number[], parts: SegPart[]): number[][] | null {
    if (members.length < 2) return null;
    const centres = members.map((index) => ({ index, x: parts[index].cx, y: parts[index].cy }));
    const axis = majorAxis(centres);
    if (axis === null) return null;
    const acrossX = -Math.sin(axis);
    const acrossY = Math.cos(axis);
    const ranked = centres
        .map((entry) => ({ ...entry, across: entry.x * acrossX + entry.y * acrossY }))
        .sort((a, b) => a.across - b.across);
    const runs: number[][] = [];
    let run: number[] = [];
    let previous = Number.NEGATIVE_INFINITY;
    for (const entry of ranked) {
        if (run.length > 0 && entry.across - previous > 8) {
            runs.push(run);
            run = [];
        }
        run.push(entry.index);
        previous = entry.across;
    }
    if (run.length > 0) runs.push(run);

    const lines = runs.filter((group) => {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const index of group) {
            const part = parts[index];
            if (part.minX < minX) minX = part.minX;
            if (part.minY < minY) minY = part.minY;
            if (part.maxX > maxX) maxX = part.maxX;
            if (part.maxY > maxY) maxY = part.maxY;
        }
        const long = Math.max(maxX - minX, maxY - minY);
        const short = Math.max(1, Math.min(maxX - minX, maxY - minY));
        return long >= 12 && long >= short * 1.8;
    });
    return lines.length >= 2 ? lines : null;
}

/** One column, from the seg parts that sit on that line. */
function boxForColumn(group: number[], seed: Box, parts: SegPart[], prepared: Prepared): Box {
    const points = group.flatMap((index) => partCorners(parts[index]));
    const fitted = longAxis(group.flatMap((index) => parts[index].points));
    const angle = uprightAngle(fitted ? fitted.angle : (seed.height >= seed.width ? Math.PI / 2 : 0));
    const box = boxAtAngle(points, angle, seed.score, prepared);
    if (Math.abs(box.angle ?? 0) >= 0.01) return box;

    const along = box.height >= box.width;
    const crossOf = (part: SegPart) => along ? part.cx : part.cy;
    const cluster = medianOf(group.map((index) => crossOf(parts[index])));
    const halfWidth = harmonicMean(group.map((index) => {
        const part = parts[index];
        return along
            ? Math.max(Math.abs(part.minX - cluster), Math.abs(part.maxX - cluster))
            : Math.max(Math.abs(part.minY - cluster), Math.abs(part.maxY - cluster));
    }));
    if (halfWidth <= 0) return box;
    const pad = 2;
    if (along) {
        const x = Math.max(0, cluster - halfWidth - pad);
        const right = Math.min(prepared.width, cluster + halfWidth + pad);
        box.x = x;
        box.width = Math.max(1, right - x);
    } else {
        const y = Math.max(0, cluster - halfWidth - pad);
        const bottom = Math.min(prepared.height, cluster + halfWidth + pad);
        box.y = y;
        box.height = Math.max(1, bottom - y);
    }
    box.angle = 0;
    box.lineLength = undefined;
    box.lineThickness = undefined;
    return box;
}

function partCorners(part: SegPart): { x: number; y: number }[] {
    return [
        { x: part.minX, y: part.minY },
        { x: part.maxX, y: part.minY },
        { x: part.minX, y: part.maxY },
        { x: part.maxX, y: part.maxY },
    ];
}

/**
 * The drawn rectangle uses the seg angle. Near an axis the page box is enough;
 * a real lean stores the length along the sentence and the thickness across it.
 */
function boxAtAngle(
    points: { x: number; y: number }[],
    angle: number,
    score: number,
    prepared: Prepared,
    keepLean = false,
): Box {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
    }
    const pad = 4;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(prepared.width, maxX + pad);
    maxY = Math.min(prepared.height, maxY + pad);

    let stored = foldAngle(angle);
    if (stored > Math.PI / 4) stored -= Math.PI / 2;
    else if (stored <= -Math.PI / 4) stored += Math.PI / 2;

    const box: Box = {
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
        score,
    };
    // A few degrees off an axis is italic on an upright line. Keeping it tilts
    // the box into the next column. A larger lean is the line itself.
    if (!keepLean && Math.abs(stored) < UPRIGHT_LIMIT) return box;

    const alongX = Math.cos(angle);
    const alongY = Math.sin(angle);
    const acrossX = -alongY;
    const acrossY = alongX;
    const centreX = (minX + maxX) / 2;
    const centreY = (minY + maxY) / 2;
    let alongMin = Infinity;
    let alongMax = -Infinity;
    let acrossMin = Infinity;
    let acrossMax = -Infinity;
    for (const point of points) {
        const along = (point.x - centreX) * alongX + (point.y - centreY) * alongY;
        const across = (point.x - centreX) * acrossX + (point.y - centreY) * acrossY;
        if (along < alongMin) alongMin = along;
        if (along > alongMax) alongMax = along;
        if (across < acrossMin) acrossMin = across;
        if (across > acrossMax) acrossMax = across;
    }
    box.angle = stored;
    box.lineLength = Math.max(Math.abs(alongMin), Math.abs(alongMax)) * 2 + pad * 2;
    box.lineThickness = Math.max(Math.abs(acrossMin), Math.abs(acrossMax)) * 2 + pad * 2;
    return box;
}

/** Box of the det hull. The angle is the principal axis of the main cluster. */
function boxFromDetHull(
    points: { x: number; y: number }[],
    score: number,
    prepared: Prepared,
): Box | null {
    const cluster = mainCluster(points);
    if (!cluster) return null;
    return boxAtAngle(cluster.points, cluster.angle, score, prepared);
}

/**
 * Seg chooses which det pixels belong to the line. The drawn box is the
 * minimum rectangle of those det pixels, so a leaned line stays leaned.
 */
type PageRect = { x: number; y: number; width: number; height: number };

function containsPoint(rect: PageRect, x: number, y: number): boolean {
    return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function segmentsCross(
    ax: number, ay: number, bx: number, by: number,
    cx: number, cy: number, dx: number, dy: number,
): boolean {
    const side = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
        (qx - px) * (ry - py) - (qy - py) * (rx - px);
    const abC = side(ax, ay, bx, by, cx, cy);
    const abD = side(ax, ay, bx, by, dx, dy);
    const cdA = side(cx, cy, dx, dy, ax, ay);
    const cdB = side(cx, cy, dx, dy, bx, by);
    return abC * abD < 0 && cdA * cdB < 0;
}

/** True when the step from one point to the next enters or leaves a balloon. */
export function pathCrossesBubble(regions: PageRect[], x0: number, y0: number, x1: number, y1: number): boolean {
    for (const region of regions) {
        const right = region.x + region.width;
        const bottom = region.y + region.height;
        const inside = (x: number, y: number) => containsPoint(region, x, y);
        if (inside(x0, y0) !== inside(x1, y1)) return true;
        if (inside(x0, y0)) continue;
        const hit = segmentsCross(x0, y0, x1, y1, region.x, region.y, right, region.y)
            || segmentsCross(x0, y0, x1, y1, right, region.y, right, bottom)
            || segmentsCross(x0, y0, x1, y1, right, bottom, region.x, bottom)
            || segmentsCross(x0, y0, x1, y1, region.x, bottom, region.x, region.y);
        if (hit) return true;
    }
    return false;
}

/**
 * A core that already runs through a balloon edge is two lines. Cut on every
 * edge that crosses the core, along the core's long side.
 */
function splitAtBubbleEdges(box: Box, regions: PageRect[]): Box[] {
    const vertical = box.height >= box.width;
    const edges: number[] = [];
    for (const region of regions) {
        if (vertical) {
            if (region.x >= box.x + box.width || region.x + region.width <= box.x) continue;
            for (const edge of [region.y, region.y + region.height]) {
                if (edge > box.y + 4 && edge < box.y + box.height - 4) edges.push(edge);
            }
        } else if (region.y < box.y + box.height && region.y + region.height > box.y) {
            for (const edge of [region.x, region.x + region.width]) {
                if (edge > box.x + 4 && edge < box.x + box.width - 4) edges.push(edge);
            }
        }
    }
    if (edges.length === 0) return [box];
    const unique = [...new Set(edges.map((edge) => Math.round(edge)))].sort((a, b) => a - b);
    const pieces: Box[] = [];
    let cursor = vertical ? box.y : box.x;
    const end = vertical ? box.y + box.height : box.x + box.width;
    const push = (from: number, to: number) => {
        if (to - from < 4) return;
        pieces.push(vertical
            ? { ...box, y: from, height: to - from, angle: 0, lineLength: undefined, lineThickness: undefined }
            : { ...box, x: from, width: to - from, angle: 0, lineLength: undefined, lineThickness: undefined });
    };
    for (const edge of unique) {
        push(cursor, edge);
        cursor = edge;
    }
    push(cursor, end);
    return pieces.length > 1 ? pieces : [box];
}

/**
 * Drop the part of a finished line that stepped across a balloon edge.
 * The origin is where the line started, so a column that began above a balloon
 * loses only the part that entered it.
 */
export function stopAtBubbles<T extends Box>(box: T, originX: number, originY: number, regions: PageRect[]): T {
    let x = box.x;
    let y = box.y;
    let right = box.x + box.width;
    let bottom = box.y + box.height;
    for (const region of regions) {
        const regionRight = region.x + region.width;
        const regionBottom = region.y + region.height;
        const originInside = containsPoint(region, originX, originY);
        const overlaps = right > region.x && x < regionRight && bottom > region.y && y < regionBottom;
        if (!originInside && !overlaps) continue;
        if (originInside) {
            x = Math.max(x, region.x);
            y = Math.max(y, region.y);
            right = Math.min(right, regionRight);
            bottom = Math.min(bottom, regionBottom);
            continue;
        }
        if (originY <= region.y) bottom = Math.min(bottom, region.y);
        else if (originY >= regionBottom) y = Math.max(y, regionBottom);
        else if (originX <= region.x) right = Math.min(right, region.x);
        else x = Math.max(x, regionRight);
    }
    if (right - x < 4 || bottom - y < 4) return box;
    if (x === box.x && y === box.y && right === box.x + box.width && bottom === box.y + box.height) return box;
    return {
        ...box,
        x,
        y,
        width: right - x,
        height: bottom - y,
        angle: 0,
        lineLength: undefined,
        lineThickness: undefined,
    };
}

/**
 * The line starts thin. Each edge walks outward while det is still there. It
 * stops in a gap: either the mask goes empty, or it bottoms out and climbs
 * into the next line.
 */
export function extendCutEnds<T extends Box>(
    box: T,
    det: { data: Float32Array; scale: number; padX: number; padY: number },
    page: { width: number; height: number },
    vertical = box.height >= box.width,
    bounds?: { x: number; y: number; width: number; height: number },
): T {
    // The hull already set a lean. Growing the page rectangle would flatten it.
    if (Math.abs(box.angle ?? 0) >= 0.01) return box;

    const size = DETECTOR_INPUT_SIZE;
    const hole = 4;
    // The debug map still paints det down here. The 0.25 core stops short of it.
    const floor = 0.05;

    const at = (pageX: number, pageY: number): number => {
        const mx = Math.round(pageX * det.scale + det.padX);
        const my = Math.round(pageY * det.scale + det.padY);
        if (mx < 0 || my < 0 || mx >= size || my >= size) return 0;
        return det.data[my * size + mx];
    };

    // acrossX: this edge moves in x, so the sample runs along y.
    const band = (cursor: number, from: number, to: number, acrossX: boolean): number => {
        const span = Math.max(1, to - from);
        const steps = Math.max(1, Math.ceil(span));
        let best = 0;
        for (let index = 0; index < steps; index += 1) {
            const pos = from + span * ((index + 0.5) / steps);
            const score = acrossX ? at(cursor, pos) : at(pos, cursor);
            if (score > best) best = score;
        }
        return best;
    };

    const minX = bounds ? Math.max(0, bounds.x) : 0;
    const minY = bounds ? Math.max(0, bounds.y) : 0;
    const maxX = bounds ? Math.min(page.width, bounds.x + bounds.width) : page.width;
    const maxY = bounds ? Math.min(page.height, bounds.y + bounds.height) : page.height;

    const walk = (
        start: number,
        step: number,
        low: number,
        high: number,
        from: number,
        to: number,
        acrossX: boolean,
    ): number => {
        let peak = band(start, from, to, acrossX);
        for (let back = 1; back <= 6; back += 1) {
            const inside = start - step * back;
            if (inside < low || inside > high) break;
            peak = Math.max(peak, band(inside, from, to, acrossX));
        }
        let trough = peak;
        let troughAt = start;
        let empty = 0;
        let cursor = start;
        let last = start;
        while (empty <= hole) {
            const next = cursor + step;
            if (next < low || next > high) break;
            cursor = next;
            const score = band(cursor, from, to, acrossX);
            if (score > peak) peak = score;
            if (score < trough) {
                trough = score;
                troughAt = cursor;
            } else if (trough < peak * 0.45 && score > trough + 0.1 && score > peak * 0.35) {
                // The score fell into the gap and is climbing into the next line.
                return troughAt;
            }
            if (score >= floor) {
                empty = 0;
                last = cursor;
            } else {
                empty += 1;
            }
        }
        return last;
    };

    let x = box.x;
    let y = box.y;
    let right = box.x + box.width;
    let bottom = box.y + box.height;
    const growX = () => {
        const left = walk(x, -1, minX, maxX, y, bottom, true);
        const far = walk(right, 1, minX, maxX, y, bottom, true);
        if (left < x) x = Math.max(minX, left - 2);
        if (far > right) right = Math.min(maxX, far + 2);
    };
    const growY = () => {
        const top = walk(y, -1, minY, maxY, x, right, false);
        const far = walk(bottom, 1, minY, maxY, x, right, false);
        if (top < y) y = Math.max(minY, top - 2);
        if (far > bottom) bottom = Math.min(maxY, far + 2);
    };
    // Open the thin side first, so the long side can see the det beside the seed.
    if (vertical) {
        growX();
        growY();
    } else {
        growY();
        growX();
    }
    if (x === box.x && y === box.y && right === box.x + box.width && bottom === box.y + box.height) return box;
    return {
        ...box,
        x,
        y,
        width: Math.max(1, right - x),
        height: Math.max(1, bottom - y),
        angle: 0,
        lineLength: undefined,
        lineThickness: undefined,
    };
}

function alignDetToSeg(
    boxes: Box[],
    seg: Float32Array,
    det: Float32Array,
    prepared: Prepared,
    regions: PageRect[],
): Box[] {
    const parts = segParts(seg, prepared);
    const claimed = parts.map(() => false);
    const chosen = parts.map(() => false);
    const used = new Uint8Array(DETECTOR_INPUT_SIZE * DETECTOR_INPUT_SIZE);
    const order = boxes
        .map((_, index) => index)
        .sort((a, b) => Math.max(boxes[b].width, boxes[b].height) - Math.max(boxes[a].width, boxes[a].height));
    const result: Box[] = [];
    const size = DETECTOR_INPUT_SIZE;

    for (const index of order) {
        const pieces = splitAtBubbleEdges(boxes[index], regions);
        const along = boxes[index].height >= boxes[index].width;
        const finish = (box: Box, originX: number, originY: number): Box => {
            const clipped = stopAtBubbles(box, originX, originY, regions);
            return extendCutEnds(
                clipped,
                { data: det, scale: prepared.scale, padX: prepared.padX, padY: prepared.padY },
                prepared,
                along,
            );
        };
        for (const seed of pieces) {
        const originX = seed.x + seed.width / 2;
        const originY = seed.y + seed.height / 2;
        if (result.some((box) => centreInside(box, originX, originY))) continue;

        const members: number[] = [];
        for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
            if (claimed[partIndex] || !overlapsCore(parts[partIndex], seed, 4)) continue;
            if (pathCrossesBubble(regions, originX, originY, parts[partIndex].cx, parts[partIndex].cy)) continue;
            members.push(partIndex);
            chosen[partIndex] = true;
        }
        const columns = columnGroups(members, parts);
        if (columns) {
            const covered = new Set<number>();
            for (const group of columns) {
                let centreX = 0;
                let centreY = 0;
                for (const index of group) {
                    covered.add(index);
                    claimed[index] = true;
                    centreX += parts[index].cx;
                    centreY += parts[index].cy;
                }
                centreX /= group.length;
                centreY /= group.length;
                result.push(finish(boxForColumn(group, seed, parts, prepared), centreX, centreY));
            }
            for (const index of members) {
                if (!covered.has(index)) chosen[index] = false;
            }
            continue;
        }
        const cloud = members.flatMap((partIndex) => parts[partIndex].points);
        const core = mainCluster(cloud);
        if (core && core.points.length < cloud.length) {
            const acrossX = -Math.sin(core.angle);
            const acrossY = Math.cos(core.angle);
            let lo = Infinity;
            let hi = -Infinity;
            for (const point of core.points) {
                const across = point.x * acrossX + point.y * acrossY;
                if (across < lo) lo = across;
                if (across > hi) hi = across;
            }
            const kept = members.filter((partIndex) => {
                const part = parts[partIndex];
                const across = part.cx * acrossX + part.cy * acrossY;
                return across >= lo && across <= hi;
            });
            if (kept.length > 0 && kept.length < members.length) {
                for (const partIndex of members) {
                    if (!kept.includes(partIndex)) chosen[partIndex] = false;
                }
                members.length = 0;
                members.push(...kept);
            }
        }
        if (members.length === 0) {
            result.push(finish(unclip(seed), originX, originY));
            continue;
        }

        const axis = longAxis(members.flatMap((partIndex) => parts[partIndex].points));
        const angle = uprightAngle(axis ? axis.angle : (seed.height >= seed.width ? Math.PI / 2 : 0));
        const thickness = axis ? axis.thickness : Math.min(seed.width, seed.height);
        const minor = Math.min(seed.width, seed.height);
        const half = Math.max(minor / 2, Math.min(thickness, minor * 1.5) / 2) + 2;
        const dirX = Math.cos(angle);
        const dirY = Math.sin(angle);
        const acrossX = -dirY;
        const acrossY = dirX;
        const alongOf = (x: number, y: number) => (x - originX) * dirX + (y - originY) * dirY;

        const seedAlong = [
            alongOf(seed.x, seed.y),
            alongOf(seed.x + seed.width, seed.y),
            alongOf(seed.x, seed.y + seed.height),
            alongOf(seed.x + seed.width, seed.y + seed.height),
        ];
        const lo = Math.min(...seedAlong);
        const hi = Math.max(...seedAlong);
        const originMx = originX * prepared.scale + prepared.padX;
        const originMy = originY * prepared.scale + prepared.padY;
        const halfMap = half * prepared.scale;
        let detMinX = Infinity;
        let detMinY = Infinity;
        let detMaxX = -Infinity;
        let detMaxY = -Infinity;
        let detCount = 0;
        const detPoints: { x: number; y: number }[] = [];

        const take = (alongMap: number): boolean => {
            const mapX = originMx + alongMap * dirX;
            const mapY = originMy + alongMap * dirY;
            let hit = false;
            const limit = Math.ceil(halfMap);
            for (let step = -limit; step <= limit; step += 1) {
                const mx = Math.round(mapX + step * acrossX);
                const my = Math.round(mapY + step * acrossY);
                if (mx < 0 || my < 0 || mx >= size || my >= size) continue;
                const pixel = my * size + mx;
                if (used[pixel] || det[pixel] < DETECTOR_SCORE_THRESHOLD) continue;
                used[pixel] = 1;
                hit = true;
                const pageX = (mx - prepared.padX) / prepared.scale;
                const pageY = (my - prepared.padY) / prepared.scale;
                if (pageX < detMinX) detMinX = pageX;
                if (pageY < detMinY) detMinY = pageY;
                if (pageX > detMaxX) detMaxX = pageX;
                if (pageY > detMaxY) detMaxY = pageY;
                detPoints.push({ x: pageX, y: pageY });
                detCount += 1;
            }
            return hit;
        };

        const loMap = Math.floor(lo * prepared.scale);
        const hiMap = Math.ceil(hi * prepared.scale);
        for (let along = loMap; along <= hiMap; along += 1) take(along);
        const extend = (start: number, step: number) => {
            let empty = 0;
            let along = start;
            const gap = DET_LINE_GAP * prepared.scale;
            while (empty < gap && Math.abs(along) < size * 2) {
                along += step;
                const pageX = (originMx + along * dirX - prepared.padX) / prepared.scale;
                const pageY = (originMy + along * dirY - prepared.padY) / prepared.scale;
                if (pathCrossesBubble(regions, originX, originY, pageX, pageY)) break;
                empty = take(along) ? 0 : empty + 1;
            }
        };
        extend(loMap, -1);
        extend(hiMap, 1);

        // The walk follows one axis and can miss the corners of a leaned blob.
        // The seed rectangle is that blob, so its det pixels complete the hull.
        const seedX0 = Math.max(0, Math.floor(seed.x * prepared.scale + prepared.padX));
        const seedY0 = Math.max(0, Math.floor(seed.y * prepared.scale + prepared.padY));
        const seedX1 = Math.min(size - 1, Math.ceil((seed.x + seed.width) * prepared.scale + prepared.padX));
        const seedY1 = Math.min(size - 1, Math.ceil((seed.y + seed.height) * prepared.scale + prepared.padY));
        for (let my = seedY0; my <= seedY1; my += 1) {
            const row = my * size;
            for (let mx = seedX0; mx <= seedX1; mx += 1) {
                if (det[row + mx] < DETECTOR_SCORE_THRESHOLD) continue;
                detPoints.push({
                    x: (mx - prepared.padX) / prepared.scale,
                    y: (my - prepared.padY) / prepared.scale,
                });
            }
        }

        const sizes = members.map((partIndex) => Math.min(
            parts[partIndex].maxX - parts[partIndex].minX,
            parts[partIndex].maxY - parts[partIndex].minY,
        )).sort((a, b) => a - b);
        const median = sizes[Math.floor(sizes.length / 2)] ?? minor;
        const link = Math.max(14, median * 0.75);

        let grew = true;
        while (grew) {
            grew = false;
            let spanLo = Infinity;
            let spanHi = -Infinity;
            for (const partIndex of members) {
                for (const corner of partCorners(parts[partIndex])) {
                    const along = alongOf(corner.x, corner.y);
                    if (along < spanLo) spanLo = along;
                    if (along > spanHi) spanHi = along;
                }
            }
            for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
                if (claimed[partIndex] || chosen[partIndex]) continue;
                const part = parts[partIndex];
                const perp = Math.abs((part.cx - originX) * acrossX + (part.cy - originY) * acrossY);
                if (perp > half) continue;
                if (pathCrossesBubble(regions, originX, originY, part.cx, part.cy)) continue;
                let partLo = Infinity;
                let partHi = -Infinity;
                for (const corner of partCorners(part)) {
                    const along = alongOf(corner.x, corner.y);
                    if (along < partLo) partLo = along;
                    if (along > partHi) partHi = along;
                }
                const gap = partHi >= spanLo && partLo <= spanHi
                    ? 0
                    : partHi < spanLo ? spanLo - partHi : partLo - spanHi;
                if (gap > link) continue;
                members.push(partIndex);
                chosen[partIndex] = true;
                grew = true;
            }
        }

        const crossCenter = (part: SegPart) => along ? part.cx : part.cy;
        const crossReach = (part: SegPart, center: number) => along
            ? Math.max(Math.abs(part.minX - center), Math.abs(part.maxX - center))
            : Math.max(Math.abs(part.minY - center), Math.abs(part.maxY - center));
        const cluster = medianOf(members.map((partIndex) => crossCenter(parts[partIndex])));
        const stroke = medianOf(members.map((partIndex) => along
            ? parts[partIndex].maxX - parts[partIndex].minX
            : parts[partIndex].maxY - parts[partIndex].minY));
        const offsets = members.map((partIndex) => Math.abs(crossCenter(parts[partIndex]) - cluster));
        const offsetGate = Math.max(stroke, medianOf(offsets) * 3, 8);
        const kept = members.filter((partIndex) => Math.abs(crossCenter(parts[partIndex]) - cluster) <= offsetGate);
        if (kept.length > 0 && kept.length < members.length) {
            for (const partIndex of members) {
                if (!kept.includes(partIndex)) chosen[partIndex] = false;
            }
            members.length = 0;
            members.push(...kept);
        }

        for (const partIndex of members) claimed[partIndex] = true;
        const points = members.flatMap((partIndex) => partCorners(parts[partIndex]));
        const fitted = longAxis(members.flatMap((partIndex) => parts[partIndex].points));
        const hullBox = boxFromDetHull(detPoints, seed.score, prepared);
        const fittedBox = hullBox ?? boxAtAngle(points, uprightAngle(fitted ? fitted.angle : angle), seed.score, prepared);
        const halfWidth = harmonicMean(members.map((partIndex) => crossReach(parts[partIndex], cluster)));
        const pad = 2;
        // An upright column takes its width from the seg reaches. A hull that
        // stayed leaned is already the minimum rectangle, so it is left alone.
        if (!hullBox && halfWidth > 0 && Math.abs(fittedBox.angle ?? 0) < 0.01) {
            if (along) {
                const x = Math.max(0, cluster - halfWidth - pad);
                const right = Math.min(prepared.width, cluster + halfWidth + pad);
                const top = Math.max(0, Math.min(fittedBox.y, detCount > 0 ? detMinY - pad : fittedBox.y));
                const bottom = Math.min(
                    prepared.height,
                    Math.max(fittedBox.y + fittedBox.height, detCount > 0 ? detMaxY + pad : fittedBox.y + fittedBox.height),
                );
                fittedBox.x = x;
                fittedBox.width = Math.max(1, right - x);
                fittedBox.y = top;
                fittedBox.height = Math.max(1, bottom - top);
            } else {
                const y = Math.max(0, cluster - halfWidth - pad);
                const bottom = Math.min(prepared.height, cluster + halfWidth + pad);
                const left = Math.max(0, Math.min(fittedBox.x, detCount > 0 ? detMinX - pad : fittedBox.x));
                const right = Math.min(
                    prepared.width,
                    Math.max(fittedBox.x + fittedBox.width, detCount > 0 ? detMaxX + pad : fittedBox.x + fittedBox.width),
                );
                fittedBox.y = y;
                fittedBox.height = Math.max(1, bottom - y);
                fittedBox.x = left;
                fittedBox.width = Math.max(1, right - left);
            }
            fittedBox.angle = 0;
            fittedBox.lineLength = undefined;
            fittedBox.lineThickness = undefined;
        }
        result.push(finish(fittedBox, originX, originY));
        }
    }

    result.sort((a, b) => (Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x));
    return result;
}

type Pass = {
    boxes: Box[];
    blocks: TextBlock[];
    mask: { data: Float32Array; scale: number; padX: number; padY: number } | null;
    det: { data: Float32Array; scale: number; padX: number; padY: number } | null;
};

async function runPass(source: PixelSource, regions: PageRect[]): Promise<Pass> {
    const session = await loadDetector();
    const inputName = session.inputNames[0];
    if (!inputName) throw new Error('The detector exposes no input.');

    const prepared = await prepareInput(source);
    const outputs = await session.run({ [inputName]: prepared.tensor });
    const typed = outputs as Record<string, ort.Tensor>;
    const map = pickTextMap(typed);
    if (!map) throw new Error('The detector returned no score map.');

    const blockTensor = pickBlockTensor(typed);
    const blocks = blockTensor ? toBlkBoxes(blockTensor, prepared) : [];
    const seg = pickSegMask(typed);
    const cores = toDetBoxes(map, prepared);
    const detBoxes = seg ? alignDetToSeg(cores, seg, map, prepared, regions) : cores.map(unclip);
    const segBoxes = seg ? toSegBoxes(seg, prepared) : [];
    const extra = segBoxes.filter((box) => !detBoxes.some((other) => overlapRatio(box, other) > 0.5));

    const letterbox = { scale: prepared.scale, padX: prepared.padX, padY: prepared.padY };
    const boxes = suppressOverlaps([...detBoxes, ...extra]);
    return {
        boxes,
        blocks,
        mask: seg ? { data: seg, ...letterbox } : null,
        det: { data: map, ...letterbox },
    };
}

/** Drop a box that mostly sits inside a larger one. Side-by-side lines barely overlap, so they stay. */
export function suppressOverlaps<T extends Box>(boxes: T[]): T[] {
    const ranked = [...boxes].sort((a, b) => b.width * b.height - a.width * a.height);
    const kept: T[] = [];
    for (const box of ranked) {
        if (kept.some((other) => overlapRatio(box, other) >= 0.5)) continue;
        kept.push(box);
    }
    return kept;
}

function overlapRatio(a: Box, b: Box): number {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    if (right <= left || bottom <= top) return 0;
    const shared = (right - left) * (bottom - top);
    return shared / Math.min(a.width * a.height, b.width * b.height);
}

/**
 * The target project letterboxes the whole page to 1024 and runs the detector
 * once. Tiling was our own addition; it multiplied the pass count and cost far
 * more than the small-text gain was worth, so the final path is one pass again.
 */
export async function detectBoxes(
    bitmap: ImageBitmap,
    regions: PageRect[] = [],
): Promise<DetectionResult> {
    const single = await runPass(bitmap, regions);
    return { detBoxes: single.boxes, blkBoxes: single.blocks, mask: single.mask, det: single.det };
}
