import {
  OFFSCREEN_TARGET,
  SERVICE_WORKER_TARGET,
  type DetectRequest,
  type OffscreenDetectRequest,
  type OffscreenPing,
} from './messages';

/** Popup to service worker: translate this image, using the tab as referer. */
function detectForWorker(imageUrl: string, tabPageUrl?: string): DetectRequest {
  return { target: SERVICE_WORKER_TARGET, type: 'detect', imageUrl, tabPageUrl };
}

/** Service worker to offscreen document: fetch and run the detector. */
function detectForOffscreen(imageUrl: string): OffscreenDetectRequest {
  return { target: OFFSCREEN_TARGET, type: 'detect', imageUrl };
}

/** Service worker to offscreen document: is a listener ready yet. */
function pingForOffscreen(): OffscreenPing {
  return { target: OFFSCREEN_TARGET, type: 'ping' };
}

const messageFactories = {
  detectForWorker,
  detectForOffscreen,
  pingForOffscreen,
};

export default messageFactories;
