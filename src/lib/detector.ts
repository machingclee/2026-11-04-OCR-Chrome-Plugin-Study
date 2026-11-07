import * as ort from 'onnxruntime-web/wasm';
import {
  DETECTOR_INPUT_SIZE,
  DETECTOR_MIN_AREA,
  DETECTOR_MIN_MEAN_SCORE,
  DETECTOR_MODEL_PATH,
  DETECTOR_SCORE_THRESHOLD,
} from '../shared/constants';

ort.env.wasm.numThreads = 1;

export type Box = { x: number; y: number; width: number; height: number; score: number };

type Prepared = {
  tensor: ort.Tensor;
  scale: number;
  padX: number;
  padY: number;
  width: number;
  height: number;
};

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

function pickScoreMap(outputs: Record<string, ort.Tensor>): Float32Array | null {
  const entries = Object.entries(outputs);
  const named = entries.find(([key]) => key.toLowerCase().includes('det'));
  const ordered = named ? [named, ...entries.filter(([key]) => key !== named[0])] : entries;

  for (const [, value] of ordered) {
    if (!(value instanceof ort.Tensor) || !(value.data instanceof Float32Array)) continue;
    const dims = value.dims;
    if (
      dims.length === 4
      && dims[0] === 1
      && dims[1] === 1
      && value.data.length === DETECTOR_INPUT_SIZE * DETECTOR_INPUT_SIZE
    ) {
      return value.data;
    }
  }
  return null;
}

function toBoxes(map: Float32Array, prepared: Prepared): Box[] {
  const size = DETECTOR_INPUT_SIZE;
  const visited = new Uint8Array(size * size);
  const boxes: Box[] = [];
  const stack: number[] = [];

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

    boxes.push({ x: left, y: top, width: right - left, height: bottom - top, score });
  }

  boxes.sort((a, b) => (Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x));
  return boxes;
}

export async function detectBoxes(bitmap: ImageBitmap): Promise<Box[]> {
  const session = await loadDetector();
  const inputName = session.inputNames[0];
  if (!inputName) throw new Error('The detector exposes no input.');

  const prepared = await prepareInput(bitmap);
  const outputs = await session.run({ [inputName]: prepared.tensor });
  const map = pickScoreMap(outputs as Record<string, ort.Tensor>);
  if (!map) throw new Error('The detector returned no score map.');
  return toBoxes(map, prepared);
}
