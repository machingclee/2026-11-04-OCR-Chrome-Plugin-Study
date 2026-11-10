import type { PingResponse } from '../types';

/** Responses addressed to the service worker. */
function ofPing(): PingResponse {
    return { ok: true };
}

const serviceWorkerResponseFactory = { ofPing };

export default serviceWorkerResponseFactory;
