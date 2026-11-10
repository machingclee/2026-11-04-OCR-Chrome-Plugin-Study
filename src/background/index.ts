import { REFERER_RULE_ID } from '../shared/constants';
import {
  LAST_RESULT_KEY,
  OFFSCREEN_DOCUMENT_PATH,
  OFFSCREEN_TARGET,
  SERVICE_WORKER_TARGET,
  type DetectResponse,
  type IncomingMessage,
} from '../shared/messages';

let offscreenReady: Promise<void> | null = null;

async function createOffscreenDocument(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: 'Run the ONNX detector outside the popup so the model stays loaded.',
  });
}

async function pingOffscreen(): Promise<boolean> {
  try {
    await chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, type: 'ping' });
    return true;
  } catch {
    return false;
  }
}

async function ensureOffscreen(): Promise<void> {
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

async function runDetection(request: IncomingMessage): Promise<DetectResponse> {
  if (typeof request.url !== 'string') return { ok: false, error: 'Missing image url.' };

  await ensureOffscreen();

  const withReferer = typeof request.pageUrl === 'string' && request.pageUrl.startsWith('http');
  if (withReferer) await installRefererRule(request.url, request.pageUrl as string);

  try {
    const response = (await chrome.runtime.sendMessage({
      target: OFFSCREEN_TARGET,
      type: 'detect',
      url: request.url,
    })) as DetectResponse | undefined;

    if (!response) return { ok: false, error: 'The offscreen document sent no answer.' };

    if (response.ok) {
      await chrome.storage.session.set({
        [LAST_RESULT_KEY]: { url: request.url, boxes: response.boxes, ms: response.ms },
      });
    }
    return response;
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    if (withReferer) await removeRefererRule();
  }
}

type RequestHandler = (request: IncomingMessage) => Promise<DetectResponse>;

const handlers: Record<string, RequestHandler> = { detect: runDetection };

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as IncomingMessage | undefined;
  if (!request || request.target !== SERVICE_WORKER_TARGET) return false;

  const handler = request.type ? handlers[request.type] : undefined;
  if (!handler) return false;

  void handler(request).then(sendResponse);
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  offscreenReady = null;
});
