import { SERVICE_WORKER_TARGET } from '../constants';
import type { BatchItem, BatchStatusRequest, CancelBatchRequest, DetectRequest, TranslateBatchRequest, TranslateRequest, TranslateSettings } from '../types';

/** Messages addressed to the service worker. */
function ofDetection(imageUrl: string, tabPageUrl?: string, imageDataUrl?: string): DetectRequest {
    return imageDataUrl
        ? { target: SERVICE_WORKER_TARGET, type: 'detect', imageUrl, imageDataUrl, tabPageUrl }
        : { target: SERVICE_WORKER_TARGET, type: 'detect', imageUrl, tabPageUrl };
}

function ofTranslation(input: {
    imageUrl: string;
    imageDataUrl?: string;
    tabPageUrl?: string;
    tabId?: number;
    token?: string;
    settings?: TranslateSettings;
}): TranslateRequest {
    return { target: SERVICE_WORKER_TARGET, type: 'translate', ...input };
}

function ofBatch(items: BatchItem[], settings?: TranslateSettings): TranslateBatchRequest {
    return { target: SERVICE_WORKER_TARGET, type: 'translate-batch', items, settings };
}

function ofCancel(batchId: string): CancelBatchRequest {
    return { target: SERVICE_WORKER_TARGET, type: 'cancel-batch', batchId };
}

function ofBatchStatus(): BatchStatusRequest {
    return { target: SERVICE_WORKER_TARGET, type: 'batch-status' };
}

const serviceWorkerRequestFactory = { ofDetection, ofTranslation, ofBatch, ofCancel, ofBatchStatus };

export default serviceWorkerRequestFactory;
