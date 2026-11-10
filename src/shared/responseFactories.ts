import type { PingResponse } from './messages';

/** Offscreen document back to the worker: the listener is here. */
function pingResponse(): PingResponse {
  return { ok: true };
}

const responseFactories = {
  pingResponse,
};

export default responseFactories;
