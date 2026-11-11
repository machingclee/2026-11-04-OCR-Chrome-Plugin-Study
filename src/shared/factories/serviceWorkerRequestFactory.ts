import { SERVICE_WORKER_TARGET } from '../constants';
import type { DetectRequest } from '../types';

/** Messages addressed to the service worker. */
function ofDetection(imageUrl: string, tabPageUrl?: string, useInpaint?: boolean): DetectRequest {
    return { target: SERVICE_WORKER_TARGET, type: 'detect', imageUrl, tabPageUrl, useInpaint };
}

const serviceWorkerRequestFactory = { ofDetection };

export default serviceWorkerRequestFactory;
