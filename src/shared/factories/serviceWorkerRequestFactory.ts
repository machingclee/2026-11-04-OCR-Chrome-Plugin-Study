import { SERVICE_WORKER_TARGET } from '../constants';
import type { DetectRequest } from '../types';

/** Messages addressed to the service worker. */
function ofDetection(imageUrl: string, tabPageUrl?: string, keepOutside?: boolean): DetectRequest {
    return { target: SERVICE_WORKER_TARGET, type: 'detect', imageUrl, tabPageUrl, keepOutside };
}

const serviceWorkerRequestFactory = { ofDetection };

export default serviceWorkerRequestFactory;
