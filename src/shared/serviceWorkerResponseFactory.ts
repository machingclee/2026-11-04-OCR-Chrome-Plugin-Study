import type { PingResponse } from './messages';

/** Responses addressed to the service worker. */
function ping(): PingResponse {
  return { ok: true };
}

const serviceWorkerResponseFactory = { ping };

export default serviceWorkerResponseFactory;
