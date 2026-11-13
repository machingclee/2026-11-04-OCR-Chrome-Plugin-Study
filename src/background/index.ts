import offscreenRequestFactory from '../shared/factories/offscreenRequestFactory';
import { DETECTION_CACHE_VERSION } from '../shared/constants';
import {
    BATCH_STATE_KEY,
    CONTENT_SCRIPT_FILE,
    DEEPSEEK_KEY,
    FONT_KEY,
    GEMINI_KEY,
    DEBUG_PAGES_KEY,
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
    DebugPage,
    BatchItemState,
    BatchState,
    BatchStatusResponse,
    CancelBatchRequest,
    TranslateBatchRequest,
    TranslateBatchResponse,
    TranslateRequest,
    TranslateResponse,
    TranslateSettings,
    OffscreenInpaintResponse,
} from '../shared/types';
import { translateGroups } from '../lib/translationJob';

let offscreenReady: Promise<void> | null = null;
let translationQueue: Promise<void> = Promise.resolve();
let batchRunning = false;
let activeBatchId: string | null = null;
let batchAbort: AbortController | null = null;

/**
 * Pixels captured in the page, keyed by the token of the element they came
 * from. Batch state is written to local storage on every step, so bytes are
 * held here instead: a batch of ten captured pages would not fit in 10 MB.
 */
const capturedPixels = new Map<string, string>();

function notifyProgress(tabId: number | undefined, stage: string, provider?: string): void {
    const message = { kind: 'translate-progress' as const, stage, provider };
    if (typeof tabId === 'number') {
        void chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => undefined);
    }
    void chrome.runtime.sendMessage(message).catch(() => undefined);
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

    if (request.type === 'batch-status') {
        const status: BatchStatusResponse = {
            running: batchRunning,
            batchId: batchRunning ? activeBatchId : null,
        };
        sendResponse(status);
        return false;
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
    const imageDataUrl = typeof request.imageDataUrl === 'string' && request.imageDataUrl.length > 0
        ? request.imageDataUrl
        : undefined;
    if (!imageDataUrl && typeof request.imageUrl !== 'string') {
        return { ok: false, error: 'Missing image url.' }
    };

    await ensureOffscreenReady();

    // Only a network URL needs the page's referer; data: URLs carry their bytes.
    const withReferer = typeof request.tabPageUrl === 'string'
        && request.tabPageUrl.startsWith('http')
        && /^https?:\/\//i.test(request.imageUrl);
    if (withReferer) {
        await installRefererRule(request.imageUrl, request.tabPageUrl as string);
    }

    try {
        const response = (await chrome.runtime.sendMessage(
            offscreenRequestFactory.ofDetection(request.imageUrl, imageDataUrl),
        )) as DetectResponse | undefined;

        if (!response) return { ok: false, error: 'The offscreen document sent no answer.' };

        if (response.ok) {
            const payload = {
                version: DETECTION_CACHE_VERSION,
                imageUrl: request.imageUrl,
                boxes: response.boxes,
                previews: response.previews,
                bubbles: response.bubbles,
                blocks: response.blocks,
                groups: response.groups,
                erasedUrl: response.erasedUrl,
                originalUrl: response.originalUrl,
                detUrl: response.detUrl,
                segUrl: response.segUrl,
                ms: response.ms,
                warm: response.warm,
                timings: response.timings,
            };

            // Local storage holds 10 MB. Crops and the two score maps are the
            // large parts, so they are the first thing to drop.
            const tooBig = JSON.stringify(payload).length > 5_000_000;
            const stored = tooBig ? { ...payload, previews: [], detUrl: null, segUrl: null } : payload;
            try {
                await chrome.storage.local.set({ [LAST_RESULT_KEY]: stored });
            } catch (cause) {
                console.warn('The last result did not fit in session storage.', cause);
                if (!tooBig) {
                    await chrome.storage.local
                        .set({ [LAST_RESULT_KEY]: { ...payload, previews: [], detUrl: null, segUrl: null } })
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

async function readDebugPages(): Promise<DebugPage[]> {
    const stored = await chrome.storage.local.get(DEBUG_PAGES_KEY);
    const pages = stored[DEBUG_PAGES_KEY];
    return Array.isArray(pages) ? pages as DebugPage[] : [];
}

async function rememberDebugPage(page: DebugPage): Promise<void> {
    const pages = await readDebugPages();
    const index = page.token
        ? pages.findIndex((item) => item.token === page.token)
        : pages.findIndex((item) => item.imageUrl === page.imageUrl && item.imageUrl.length > 0);
    const next = pages.slice();
    if (index >= 0) next[index] = page;
    else next.push(page);
    const write = (list: DebugPage[]) => chrome.storage.local.set({ [DEBUG_PAGES_KEY]: list });
    try {
        await write(next);
    } catch (cause) {
        console.warn('Debug pages did not fit with the score maps.', cause);
        const slim = next.map((item) => ({ ...item, detUrl: undefined, segUrl: undefined }));
        await write(slim).catch(() => undefined);
    }
}

async function readBatch(): Promise<BatchState | null> {
    const stored = await chrome.storage.local.get(BATCH_STATE_KEY);
    const state = stored[BATCH_STATE_KEY];
    return state && typeof state === 'object' ? state as BatchState : null;
}

function batchWasCancelled(id: string): boolean {
    return batchAbort?.signal.aborted === true && activeBatchId === id;
}

async function saveBatch(state: BatchState): Promise<void> {
    if (state.status === 'running' && batchWasCancelled(state.id)) state.status = 'cancelled';
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
    // Captured pixels stay in memory; only this small descriptor is persisted.
    // Validate every item first, so an early return cannot leave bytes behind.
    const problem = request.items.find((item) => {
        const captured = typeof item.imageDataUrl === 'string' && item.imageDataUrl.length > 0;
        if (captured) return !item.token;
        return typeof item.imageUrl !== 'string' || item.imageUrl.length === 0;
    });
    if (problem) {
        const captured = typeof problem.imageDataUrl === 'string' && problem.imageDataUrl.length > 0;
        return {
            ok: false,
            error: captured
                ? 'A captured image arrived without a token.'
                : 'One of the selected images has no URL and no captured pixels.',
        };
    }
    const items: BatchItemState[] = request.items.map((item) => {
        const captured = typeof item.imageDataUrl === 'string' && item.imageDataUrl.length > 0;
        if (captured) capturedPixels.set(item.token as string, item.imageDataUrl as string);
        return { imageUrl: item.imageUrl, token: item.token, status: 'pending', captured };
    });
    try {
        const tabId = await resolveTabId(
            { target: SERVICE_WORKER_TARGET, type: 'translate', imageUrl: items[0].imageUrl, tabId: request.tabId },
            sender,
        );
        const state: BatchState = {
            id: `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            tabId,
            status: 'running',
            items,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        activeBatchId = state.id;
        batchAbort = new AbortController();
        await saveBatch(state);
        await chrome.storage.local.set({
            [DEBUG_PAGES_KEY]: items.map((item): DebugPage => ({
                token: item.token,
                imageUrl: item.imageUrl,
                boxes: [],
                bubbles: [],
                blocks: [],
                groups: [],
                ms: 0,
                ready: false,
            })),
        });
        batchRunning = true;
        void processBatch(state, request.settings);
        return { ok: true, batchId: state.id, count: state.items.length };
    } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
}

async function cancelBatch(request: CancelBatchRequest): Promise<boolean> {
    if (activeBatchId === request.batchId) batchAbort?.abort();
    const state = await readBatch();
    if (!state || state.id !== request.batchId) return false;
    if (state.status === 'cancelled') return true;
    if (state.status !== 'running') return false;
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
            if (batchWasCancelled(state.id)) {
                state.status = 'cancelled';
                await saveBatch(state);
                await notifyBatch(state);
                break;
            }
            const latest = await readBatch();
            if (!latest || latest.id !== state.id || latest.status === 'cancelled') break;
            if (item.status === 'done') continue;
            item.status = 'running';
            item.error = undefined;
            await saveBatch(state);
            if (state.status === 'cancelled') {
                await notifyBatch(state);
                break;
            }
            await notifyBatch(state);

            const captured = item.captured && item.token ? capturedPixels.get(item.token) : undefined;
            if (item.captured && !captured) {
                item.status = 'error';
                item.error = 'The captured pixels were lost when the worker restarted. Select the image again.';
                await saveBatch(state);
                await notifyBatch(state);
                continue;
            }

            let response: TranslateResponse;
            try {
                response = await enqueueTranslation(() => runTranslation(
                    {
                        target: SERVICE_WORKER_TARGET,
                        type: 'translate',
                        imageUrl: item.imageUrl,
                        imageDataUrl: captured,
                        tabId: state.tabId,
                        token: item.token,
                        settings: resolved,
                    },
                    { } as chrome.runtime.MessageSender,
                    batchAbort?.signal,
                ));
            } catch (cause) {
                if (batchWasCancelled(state.id) || (cause instanceof Error && cause.message === 'Cancelled.')) {
                    state.status = 'cancelled';
                    await saveBatch(state);
                    await notifyBatch(state);
                    break;
                }
                item.status = 'error';
                item.error = cause instanceof Error ? cause.message : String(cause);
                await saveBatch(state);
                await notifyBatch(state);
                continue;
            }
            if (batchWasCancelled(state.id)) {
                state.status = 'cancelled';
                await saveBatch(state);
                await notifyBatch(state);
                break;
            }
            item.status = response.ok ? 'done' : 'error';
            item.error = response.ok ? undefined : response.error;
            // The bytes are only needed for this one job.
            if (item.token) capturedPixels.delete(item.token);
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
        // Drop the bytes this batch never reached, so a cancelled run frees them.
        for (const item of state.items) {
            if (item.token) capturedPixels.delete(item.token);
        }
        if (activeBatchId === state.id) activeBatchId = null;
        batchRunning = false;
    }
}

async function resumeBatch(): Promise<void> {
    if (batchRunning) return;
    const state = await readBatch().catch(() => null);
    if (!state || state.status !== 'running') return;
    activeBatchId = state.id;
    batchAbort = new AbortController();
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

async function runTranslation(request: TranslateRequest, sender: chrome.runtime.MessageSender, signal?: AbortSignal): Promise<TranslateResponse> {
    // A captured blob: image arrives as pixels; a plain pick arrives as a URL.
    const imageDataUrl = request.imageDataUrl
        ?? (request.token ? capturedPixels.get(request.token) : undefined);
    if (!imageDataUrl && (typeof request.imageUrl !== 'string' || request.imageUrl.length === 0)) {
        return { ok: false, error: 'Missing image url.' };
    }

    try {
        const tabId = await resolveTabId(request, sender);
        let tabPageUrl = request.tabPageUrl;
        if (!tabPageUrl) {
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            tabPageUrl = tab?.url?.startsWith('http') ? tab.url : undefined;
        }
        notifyProgress(tabId, 'detecting');
        const detection = await runDetection({
            target: SERVICE_WORKER_TARGET,
            type: 'detect',
            imageUrl: request.imageUrl,
            imageDataUrl,
            tabPageUrl,
        });
        if (!detection.ok) return detection;
        if (signal?.aborted) throw new Error('Cancelled.');

        await rememberDebugPage({
            token: request.token,
            imageUrl: request.imageUrl,
            boxes: detection.boxes,
            bubbles: detection.bubbles,
            blocks: detection.blocks,
            groups: detection.groups.map((group) => ({ ...group, maskUrl: undefined })),
            detUrl: detection.detUrl,
            segUrl: detection.segUrl,
            ms: detection.ms,
            warm: detection.warm,
            timings: detection.timings,
            ready: true,
        });

        const settings = request.settings ?? await readSettings();
        notifyProgress(tabId, 'calling', settings.translator);
        const job = await translateGroups({
            groups: detection.groups,
            boxes: detection.boxes,
            balloons: detection.bubbles,
            imageWidth: detection.imageWidth,
            imageHeight: detection.imageHeight,
            settings,
            inpainted: detection.canInpaint,
            signal,
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

        let erasedUrl = detection.erasedUrl;
        if (signal?.aborted) throw new Error('Cancelled.');
        if (detection.canInpaint && job.items.length > 0) {
            notifyProgress(tabId, 'inpainting');
            const rubyBoxes = detection.boxes.flatMap((line) => line.ruby.map((ruby) => ({
                x: ruby.x,
                y: ruby.y,
                width: ruby.width,
                height: ruby.height,
            })));
            const painted = (await chrome.runtime.sendMessage(
                offscreenRequestFactory.ofInpaint([
                    ...job.erase,
                    ...job.items.map((item) => ({
                        x: item.x,
                        y: item.y,
                        width: item.width,
                        height: item.height,
                        angle: item.angle,
                    })),
                    ...rubyBoxes,
                ]),
            )) as OffscreenInpaintResponse | undefined;
            if (!painted) throw new Error('The offscreen document sent no inpaint answer.');
            if (!painted.ok) throw new Error(painted.error);
            erasedUrl = painted.erasedUrl;
        }

        const overlay: OverlayRequest = {
            token: request.token,
            imageUrl: request.imageUrl,
            originalUrl: detection.originalUrl,
            erasedUrl,
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
