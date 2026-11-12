import * as ort from 'onnxruntime-web/wasm';
import { OCR_DICT_PATH, OCR_MODEL_PATH } from '../../shared/constants';
import { loadCharset } from './charset';
import { decodeCtc } from './decode';
import { buildOcrInput } from './prepare';
import type { Box, OcrResult } from '../types';

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function loadSession(): Promise<ort.InferenceSession> {
    if (!sessionPromise) {
        sessionPromise = ort.InferenceSession.create(chrome.runtime.getURL(OCR_MODEL_PATH), {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
        }).catch((cause: unknown) => {
            sessionPromise = null;
            throw cause;
        });
    }
    return sessionPromise;
}

export async function recognizeLine(bitmap: ImageBitmap, box: Box, vertical: boolean): Promise<OcrResult> {
    const [session, charset] = await Promise.all([
        loadSession(),
        loadCharset(chrome.runtime.getURL(OCR_DICT_PATH)),
    ]);

    const input = buildOcrInput(bitmap, box, vertical);
    const inputName = session.inputNames[0];
    if (!inputName) throw new Error('The recogniser exposes no input.');

    const tensor = new ort.Tensor('float32', input.data, input.dims);
    const outputs = await session.run({ [inputName]: tensor });
    const first = Object.values(outputs)[0];
    if (!first || !(first.data instanceof Float32Array)) throw new Error('The recogniser returned no logits.');

    const dims = first.dims;
    const timeSteps = dims[dims.length - 2] ?? 0;
    const classes = dims[dims.length - 1] ?? 0;
    return decodeCtc(first.data, timeSteps, classes, charset);
}
