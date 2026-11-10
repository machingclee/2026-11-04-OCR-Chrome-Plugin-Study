import { SERVICE_WORKER_TARGET } from '../constants';
import type { DetectRequest } from '../types';

/** Messages addressed to the service worker. */
function detect(imageUrl: string, tabPageUrl?: string): DetectRequest {
  return { target: SERVICE_WORKER_TARGET, type: 'detect', imageUrl, tabPageUrl };
}

const serviceWorkerRequestFactory = { detect };

export default serviceWorkerRequestFactory;
