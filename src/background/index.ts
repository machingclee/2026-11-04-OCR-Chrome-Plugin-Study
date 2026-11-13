import offscreenRequestFactory from '../shared/factories/offscreenRequestFactory';
import { DETECTION_CACHE_VERSION } from '../shared/constants';
import {
    BATCH_STATE_KEY,
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
    BatchState,
    CancelBatchRequest,
    TranslateBatchRequest,
    TranslateBatchResponse,
    TranslateRequest,
    TranslateResponse,
    TranslateSettings,
} from '../shared/types';
import { translateGroups } from '../lib/translationJob';

let offscreenReady: Promise<void> | null = null;
let translationQueue: Promise<void> = Promise.resolve();
let batchRunning = false;

function notifyProgress(stage: string, provider?: string): void {
    void chrome.runtime.sendMessage({ kind: 'translate-progress', stage, provider }).catch(() => undefined);
}


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
        enqueueTranslation(() => runTranslation(request, sender)).then((response) => {
            try {
                sendResponse(response);
            } catch {
                // The popup may have closed. The overlay already ran.
            }
        });
        return true;
    }

    if (request.type === 'translate-batch') {
        startBatch(request, sender).then((response) => {
            try {
                sendResponse(response);
            } catch {
                // The content script can close during navigation.
            }
        });
        return true;
    }

    if (request.type === 'cancel-batch') {
        cancelBatch(request).then((cancelled) => {
            try {
                sendResponse({ ok: cancelled });
            } catch {
                // The content script can close during navigation.
            }
        });
        return true;
    }

    return false;
});

chrome.runtime.onInstalled.addListener(() => {
    offscreenReady = null;
});

chrome.commands.onCommand.addListener((command) => {
    if (command !== 'pick-image') return;
    void startPickMode();
});

async function startPickMode(): Promise<void> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: [CONTENT_SCRIPT_FILE],
        });
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'ISOLATED',
            func: () => {
                const picker = (globalThis as unknown as {
                    __comicTranslatorPicker?: { startSelection?: () => void };
                }).__comicTranslatorPicker;
                picker?.startSelection?.();
            },
        });
    } catch (cause) {
        console.warn('Could not start selection mode.', cause);
    }
}

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
                erasedUrl: response.erasedUrl,
                originalUrl: response.originalUrl,
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


function enqueueTranslation<T>(job: () => Promise<T>): Promise<T> {
    const next = translationQueue.then(job, job);
    translationQueue = next.then(() => undefined, () => undefined);
    return next;
}

async function readBatch(): Promise<BatchState | null> {
    const stored = await chrome.storage.local.get(BATCH_STATE_KEY);
    const state = stored[BATCH_STATE_KEY];
    return state && typeof state === 'object' ? state as BatchState : null;
}

async function saveBatch(state: BatchState): Promise<void> {
    state.updatedAt = Date.now();
    await chrome.storage.local.set({ [BATCH_STATE_KEY]: state });
}

async function notifyBatch(state: BatchState): Promise<void> {
    await chrome.tabs.sendMessage(
        state.tabId,
        { type: 'batch-progress', state } satisfies { type: 'batch-progress'; state: BatchState },
        { frameId: 0 },
    ).catch(() => undefined);
}

async function startBatch(request: TranslateBatchRequest, sender: chrome.runtime.MessageSender): Promise<TranslateBatchResponse> {
    if (batchRunning) return { ok: false, error: 'Another batch is already running.' };
    if (!Array.isArray(request.items) || request.items.length === 0) {
        return { ok: false, error: 'No images were selected.' };
    }
    try {
        const tabId = await resolveTabId(
            { target: SERVICE_WORKER_TARGET, type: 'translate', imageUrl: request.items[0].imageUrl, tabId: request.tabId },
            sender,
        );
        const state: BatchState = {
            id: `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            tabId,
            status: 'running',
            items: request.items.map((item) => ({
                imageUrl: item.imageUrl,
                token: item.token,
                status: 'pending',
            })),
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        await saveBatch(state);
        batchRunning = true;
        void processBatch(state, request.settings);
        return { ok: true, batchId: state.id, count: state.items.length };
    } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
}

async function cancelBatch(request: CancelBatchRequest): Promise<boolean> {
    const state = await readBatch();
    if (!state || state.id !== request.batchId || state.status !== 'running') return false;
    state.status = 'cancelled';
    await saveBatch(state);
    await notifyBatch(state);
    return true;
}

async function processBatch(state: BatchState, settings?: TranslateSettings): Promise<void> {
    batchRunning = true;
    try {
        const resolved = settings ?? await readSettings();
        for (const item of state.items) {
            const latest = await readBatch();
            if (!latest || latest.id !== state.id || latest.status === 'cancelled') break;
            if (item.status === 'done') continue;
            item.status = 'running';
            item.error = undefined;
            await saveBatch(state);
            await notifyBatch(state);

            const response = await enqueueTranslation(() => runTranslation(
                {
                    target: SERVICE_WORKER_TARGET,
                    type: 'translate',
                    imageUrl: item.imageUrl,
                    tabId: state.tabId,
                    token: item.token,
                    settings: resolved,
                },
                { } as chrome.runtime.MessageSender,
            ));
            item.status = response.ok ? 'done' : 'error';
            item.error = response.ok ? undefined : response.error;
            await saveBatch(state);
            await notifyBatch(state);
        }
        const finalState = await readBatch();
        if (finalState?.id === state.id && finalState.status !== 'cancelled') {
            state.status = 'done';
            await saveBatch(state);
            await notifyBatch(state);
        }
    } finally {
        batchRunning = false;
    }
}

async function resumeBatch(): Promise<void> {
    if (batchRunning) return;
    const state = await readBatch().catch(() => null);
    if (!state || state.status !== 'running') return;
    batchRunning = true;
    await processBatch(state);
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
        font: 'sans',
        leading: 1,
        weight: 'normal',
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
        let tabPageUrl = request.tabPageUrl;
        if (!tabPageUrl) {
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            tabPageUrl = tab?.url?.startsWith('http') ? tab.url : undefined;
        }
        notifyProgress('detecting');
        const detection = await runDetection({
            target: SERVICE_WORKER_TARGET,
            type: 'detect',
            imageUrl: request.imageUrl,
            tabPageUrl,
        });
        if (!detection.ok) return detection;
        notifyProgress('inpainting');

        const settings = request.settings ?? await readSettings();
        notifyProgress('calling', settings.translator);
        const job = await translateGroups({
            groups: detection.groups,
            boxes: detection.boxes,
            balloons: detection.bubbles,
            imageWidth: detection.imageWidth,
            imageHeight: detection.imageHeight,
            settings,
            inpainted: Boolean(detection.erasedUrl),
            translateBuiltin: async (lines) => {
                const response = (await chrome.runtime.sendMessage(
                    offscreenRequestFactory.ofBuiltinTranslate(lines),
                )) as { ok: true; texts: string[] } | { ok: false; error: string } | undefined;
                if (!response) throw new Error('The offscreen document sent no answer.');
                if (!response.ok) throw new Error(response.error);
                return response.texts;
            },
        });

        if (job.active !== settings.translator) {
            await chrome.storage.local.set({ [TRANSLATOR_KEY]: job.active });
        }

        const overlay: OverlayRequest = {
            token: request.token,
            imageUrl: request.imageUrl,
            originalUrl: detection.originalUrl,
            erasedUrl: detection.erasedUrl,
            width: detection.imageWidth,
            height: detection.imageHeight,
            items: job.items,
            fontFamily: 'system-ui, "PingFang TC", sans-serif',
            weight: 'normal',
            leading: 1,
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



void resumeBatch();
