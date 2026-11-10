import { detectBoxes, isSessionReady } from '../lib/detector';
import {
  OFFSCREEN_TARGET,
  type DetectResponse,
  type IncomingMessage,
  type OffscreenDetectRequest,
} from '../shared/messages';

async function runDetection(request: OffscreenDetectRequest): Promise<DetectResponse> {
  const started = performance.now();
  const warm = isSessionReady();

  try {
    const response = await fetch(request.imageUrl, { credentials: 'include' });
    if (!response.ok) {
      return { ok: false, error: `Image fetch failed with ${response.status}.` };
    }

    const bitmap = await createImageBitmap(await response.blob());
    const boxes = await detectBoxes(bitmap);
    return { ok: true, boxes, ms: Math.round(performance.now() - started), warm };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

// this is off the offscreen document
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as IncomingMessage | undefined;
  if (!request || request.target !== OFFSCREEN_TARGET) return false;

  if (request.type === 'ping') {
    sendResponse({ ok: true });
    return false;
  }

  if (request.type !== 'detect' || typeof request.imageUrl !== 'string') return false;

  void runDetection({ target: OFFSCREEN_TARGET, type: 'detect', imageUrl: request.imageUrl }).then(sendResponse);
  return true;
});
