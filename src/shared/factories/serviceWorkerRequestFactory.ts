import { SERVICE_WORKER_TARGET } from '../constants';
import type { BatchItem, DetectRequest, TranslateBatchRequest, TranslateRequest, TranslateSettings } from '../types';

/** Messages addressed to the service worker. */
function ofDetection(imageUrl: string, tabPageUrl?: string): DetectRequest {
    return { target: SERVICE_WORKER_TARGET, type: 'detect', imageUrl, tabPageUrl };
}

function ofTranslation(input: {
    imageUrl: string;
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

const serviceWorkerRequestFactory = { ofDetection, ofTranslation, ofBatch };

export default serviceWorkerRequestFactory;
