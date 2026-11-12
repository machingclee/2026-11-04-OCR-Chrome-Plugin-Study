import offscreenRequestFactory from '../shared/factories/offscreenRequestFactory';
import { DETECTION_CACHE_VERSION } from '../shared/constants';
import {
    CONTENT_SCRIPT_FILE,
    DEEPSEEK_KEY,
    FONT_KEY,
    GEMINI_KEY,
    LAST_RESULT_KEY,
    LEADING_KEY,
    OFFSCREEN_HTML,
    REFERER_RULE_ID,
    SERVICE_WORKER_TARGET,
    TRANSLATOR_KEY,
    WEIGHT_KEY,
} from '../shared/constants';
import type {
    DetectRequest,
    DetectResponse,
    IncomingMessage,
    OverlayRequest,
    OverlayResponse,
    TranslateRequest,
    TranslateResponse,
    TranslateSettings,
} from '../shared/types';
import { translateGroups } from '../lib/translationJob';

let offscreenReady: Promise<void> | null = null;


// this file is the context of service worker
// only short-lived tasks should be done here, 
// like pinging the offscreen document and relaying the detection request to it. 

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    // message directly form the frontend
    const request = message as IncomingMessage | undefined;
    if (!request || request.target !== SERVICE_WORKER_TARGET) return false;

    if (request.type === 'detect') {
        runDetection(request).then((detectionResponse) => {
            sendResponse(detectionResponse);
        });
        return true;
    }

    if (request.type === 'translate') {
        runTranslation(request, sender).then((response) => {
            try {
                sendResponse(response);
            } catch {
                // The popup may have closed. The overlay already ran.
            }
        });
        return true;
    }

    return false;
});

chrome.runtime.onInstalled.addListener(() => {
    offscreenReady = null;
});

async function runDetection(request: DetectRequest): Promise<DetectResponse> {
    if (typeof request.imageUrl !== 'string') {
        return { ok: false, error: 'Missing image url.' }
    };

    await ensureOffscreenReady();

    const withReferer = typeof request.tabPageUrl === 'string' && request.tabPageUrl.startsWith('http');
    if (withReferer) {
        await installRefererRule(request.imageUrl, request.tabPageUrl as string);
    }

    try {
        const response = (await chrome.runtime.sendMessage(
            offscreenRequestFactory.ofDetection(request.imageUrl),
        )) as DetectResponse | undefined;

        if (!response) return { ok: false, error: 'The offscreen document sent no answer.' };

        if (response.ok) {
            const payload = {
                version: DETECTION_CACHE_VERSION,
                imageUrl: request.imageUrl,
                boxes: response.boxes,
                previews: response.previews,
                bubbles: response.bubbles,
                groups: response.groups,
                ms: response.ms,
                warm: response.warm,
                timings: response.timings,
            };

            // Local storage holds 10 MB. The crops are the only large part, so
            // they are the first thing to drop when a page has many lines.
            const tooBig = JSON.stringify(payload).length > 5_000_000;
            const stored = tooBig ? { ...payload, previews: [] } : payload;
            try {
                await chrome.storage.local.set({ [LAST_RESULT_KEY]: stored });
            } catch (cause) {
                console.warn('The last result did not fit in session storage.', cause);
                if (!tooBig) {
                    // Keep the boxes and groups; only the crops are expendable.
                    await chrome.storage.local
                        .set({ [LAST_RESULT_KEY]: { ...payload, previews: [] } })
                        .catch(() => undefined);
                }
            }
        }
        return response;
    } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    } finally {
        if (withReferer) await removeRefererRule();
    }
}


async function readSettings(): Promise<TranslateSettings> {
    const local = await chrome.storage.local.get([
        DEEPSEEK_KEY,
        GEMINI_KEY,
        TRANSLATOR_KEY,
        FONT_KEY,
        LEADING_KEY,
        WEIGHT_KEY,
    ]);
    const translator = local[TRANSLATOR_KEY];
    return {
        translator: translator === 'deepseek' || translator === 'builtin' ? translator : 'gemini',
        deepSeekKey: typeof local[DEEPSEEK_KEY] === 'string' ? local[DEEPSEEK_KEY] : '',
        geminiKey: typeof local[GEMINI_KEY] === 'string' ? local[GEMINI_KEY] : '',
        font: local[FONT_KEY] === 'serif' ? 'serif' : 'sans',
        leading: typeof local[LEADING_KEY] === 'number' ? local[LEADING_KEY] : 1.15,
        weight: local[WEIGHT_KEY] === 'bold' ? 'bold' : 'normal',
    };
}

async function resolveTabId(request: TranslateRequest, sender: chrome.runtime.MessageSender): Promise<number> {
    if (typeof request.tabId === 'number') return request.tabId;
    if (typeof sender.tab?.id === 'number') return sender.tab.id;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (typeof tab?.id !== 'number') throw new Error('There is no active tab.');
    return tab.id;
}

async function runTranslation(request: TranslateRequest, sender: chrome.runtime.MessageSender): Promise<TranslateResponse> {
    if (typeof request.imageUrl !== 'string' || request.imageUrl.length === 0) {
        return { ok: false, error: 'Missing image url.' };
    }

    try {
        const tabId = await resolveTabId(request, sender);
        const detection = await runDetection({
            target: SERVICE_WORKER_TARGET,
            type: 'detect',
            imageUrl: request.imageUrl,
            tabPageUrl: request.tabPageUrl,
        });
        if (!detection.ok) return detection;

        const settings = request.settings ?? await readSettings();
        const job = await translateGroups({
            groups: detection.groups,
            boxes: detection.boxes,
            balloons: detection.bubbles,
            imageWidth: detection.imageWidth,
            imageHeight: detection.imageHeight,
            settings,
        });

        if (job.active !== settings.translator) {
            await chrome.storage.local.set({ [TRANSLATOR_KEY]: job.active });
        }

        const overlay: OverlayRequest = {
            token: request.token,
            imageUrl: request.imageUrl,
            width: detection.imageWidth,
            height: detection.imageHeight,
            items: job.items,
            fontFamily: settings.font === 'serif'
                ? '"Songti TC", "Noto Serif CJK TC", serif'
                : 'system-ui, "PingFang TC", sans-serif',
            weight: settings.weight,
            leading: settings.leading,
        };

        await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: [CONTENT_SCRIPT_FILE],
        });
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: 'ISOLATED',
            args: [overlay],
            func: (input: OverlayRequest): OverlayResponse => {
                const api = (globalThis as unknown as {
                    __comicTranslatorOverlay?: {
                        apply: (value: OverlayRequest) => OverlayResponse;
                    };
                }).__comicTranslatorOverlay;
                if (!api) {
                    return { ok: false, error: 'The overlay helper is not installed in this frame.' };
                }
                try {
                    return api.apply(input);
                } catch (cause) {
                    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
                }
            },
        });
        const answers = results.map((entry) => entry.result);
        const placed = answers.find(
            (answer): answer is { ok: true; count: number } => Boolean(answer?.ok),
        );
        if (!placed) {
            const failure = answers.find(
                (answer): answer is { ok: false; error: string } => Boolean(answer && !answer.ok),
            );
            return { ok: false, error: failure?.error ?? 'The page did not accept the overlay.' };
        }

        return {
            ok: true,
            count: placed.count,
            used: job.used,
            active: job.active,
            skipped: job.skipped,
            withBalloon: job.withBalloon,
            balloons: detection.bubbles.length,
            answers: job.answers,
            ms: detection.ms,
            warm: detection.warm,
            timings: detection.timings,
        };
    } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
}

/**
 * Create the offscreen document when it is absent. Chrome loads offscreen.html,
 * and the script that the page references starts in a new context.
 * The caller pings after this call, because the document can exist before its listener answers.
 */
async function createOffscreenDocumentContext(): Promise<void> {
    const contexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });

    if (contexts.length > 0) {
        return;
    }

    // Chrome loads the page here, and the page pulls in the bundled offscreen script.
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
            await createOffscreenDocumentContext();
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


