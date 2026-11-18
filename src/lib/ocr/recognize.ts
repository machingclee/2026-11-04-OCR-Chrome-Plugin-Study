import * as ort from 'onnxruntime-web/webgpu';
import { OCR_DICT_PATH, OCR_MODEL_PATH } from '../../shared/constants';
import { runSession, sessionFor } from '../onnx';
import { loadCharset } from './charset';
import { decodeCtc } from './decode';
import { buildOcrInput } from './prepare';
import type { Box, OcrResult } from '../types';

/** Load the recogniser once per page; a failed load is retried on the next line. */
function loadSession(): Promise<ort.InferenceSession> {
    return sessionFor('recogniser', chrome.runtime.getURL(OCR_MODEL_PATH), 'recogniser');
}

export async function recognizeLine(
    bitmap: ImageBitmap,
    box: Box,
    vertical: boolean,
    /** Shown in the progress pill, e.g. "line 7/48". */
    note?: string,
): Promise<OcrResult> {
    const [session, charset] = await Promise.all([
        loadSession(),
        loadCharset(chrome.runtime.getURL(OCR_DICT_PATH)),
    ]);

    const input = buildOcrInput(bitmap, box, vertical);
    const inputName = session.inputNames[0];
    if (!inputName) throw new Error('The recogniser exposes no input.');

    const tensor = new ort.Tensor('float32', input.data, input.dims);
    const outputs = await runSession(session, { [inputName]: tensor }, 'recogniser', undefined, note);
    const first = Object.values(outputs)[0];
    if (!first || !(first.data instanceof Float32Array)) throw new Error('The recogniser returned no logits.');

    const dims = first.dims;
    const timeSteps = dims[dims.length - 2] ?? 0;
    const classes = dims[dims.length - 1] ?? 0;
    return decodeCtc(first.data, timeSteps, classes, charset);
}
