import offscreenRequestFactory from '../shared/factories/offscreenRequestFactory';
import {
  LAST_RESULT_KEY,
  OFFSCREEN_HTML,
  REFERER_RULE_ID,
  SERVICE_WORKER_TARGET,
} from '../shared/constants';
import type { DetectRequest, DetectResponse, IncomingMessage } from '../shared/types';

let offscreenReady: Promise<void> | null = null;


// this file is the context of service worker
// only short-lived tasks should be done here, 
// like pinging the offscreen document and relaying the detection request to it. 
// The offscreen document is where the ONNX model is loaded and the actual detection is done.

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  // message directly form the frontend
  const request = message as IncomingMessage | undefined;
  if (!request || request.target !== SERVICE_WORKER_TARGET) return false;

  if (request.type !== 'detect') return false;

  void runDetection(request).then((detectionResponse) => {
    sendResponse(detectionResponse);
  });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  offscreenReady = null;
});


async function runDetection(request: DetectRequest): Promise<DetectResponse> {
  if (typeof request.imageUrl !== 'string') return { ok: false, error: 'Missing image url.' };

  await ensureOffscreenReady();

  const withReferer = typeof request.tabPageUrl === 'string' && request.tabPageUrl.startsWith('http');
  if (withReferer) {
    await installRefererRule(request.imageUrl, request.tabPageUrl as string);
  }

  try {
    const response = (await chrome.runtime.sendMessage(
      offscreenRequestFactory.ofDetect(request.imageUrl),
    )) as DetectResponse | undefined;

    if (!response) return { ok: false, error: 'The offscreen document sent no answer.' };

    if (response.ok) {
      await chrome.storage.session.set({
        [LAST_RESULT_KEY]: { imageUrl: request.imageUrl, boxes: response.boxes, ms: response.ms },
      });
    }
    return response;
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    if (withReferer) await removeRefererRule();
  }
}




async function createOffscreenDocument(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });

  if (contexts.length > 0) {
    return;
  }

  // create context, bind it into the offscreen html to execute custom js
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_HTML,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: 'Run the ONNX detector outside the popup so the model stays loaded.',
  });
}

async function pingOffscreen(): Promise<boolean> {
  try {
    await chrome.runtime.sendMessage(offscreenRequestFactory.ofPing());
    return true;
  } catch {
    return false;
  }
}

async function ensureOffscreenReady(): Promise<void> {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      await createOffscreenDocument();
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (await pingOffscreen()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('The offscreen document did not start.');
    })().catch((cause: unknown) => {
      offscreenReady = null;
      throw cause;
    });
  }
  return offscreenReady;
}

async function installRefererRule(imageUrl: string, pageUrl: string): Promise<void> {
  const host = new URL(imageUrl).hostname;
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existing.filter((rule) => rule.id === REFERER_RULE_ID).map((rule) => rule.id),
    addRules: [
      {
        id: REFERER_RULE_ID,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [
            {
              header: 'Referer',
              operation: chrome.declarativeNetRequest.HeaderOperation.SET,
              value: pageUrl,
            },
          ],
        },
        condition: {
          requestDomains: [host],
          requestMethods: [chrome.declarativeNetRequest.RequestMethod.GET],
          resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
        },
      },
    ],
  });
}

async function removeRefererRule(): Promise<void> {
  await chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [REFERER_RULE_ID] })
    .catch(() => undefined);
}


