import offscreenRequestFactory from '../shared/factories/offscreenRequestFactory';
import { DETECTION_CACHE_VERSION } from '../shared/constants';
import {
    BATCH_STATE_KEY,
    CONTENT_SCRIPT_FILE,
    DEEPSEEK_KEY,
    FONT_KEY,
    DEBUG_PAGES_KEY,
    LAST_RESULT_KEY,
    LEADING_KEY,
    OFFSCREEN_HTML,
    REASONING_EFFORT_KEY,
    REASONING_EFFORTS,
    DEFAULT_REASONING_EFFORT,
    REFERER_RULE_ID,
    SERVICE_WORKER_TARGET,
    TRANSLATOR_KEY,
    WEIGHT_KEY,
} from '../shared/constants';
import type { ReasoningEffort } from '../shared/constants';
import type {
    DetectRequest,
    DetectResponse,
    OcrRequest,
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
    InpaintBox,
    BubbleData,
} from '../shared/types';
import { translateGroups } from '../lib/translationJob';
import { blockCropBox } from '../lib/ocr/blockCrop';

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
    if (command === 'pick-image') void startPickMode();
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

/**
 * Attach the paper each box sits on. A balloon is flat paper, so the eraser
 * fills it instead of asking the model to invent a bubble; the outline keeps
 * that fill off the balloon wall. A box outside every balloon stays plain and
 * is inpainted as before.
 */
type Rectangle = { x: number; y: number; width: number; height: number };

function overlaps(left: Rectangle, right: Rectangle): boolean {
    return left.x < right.x + right.width && right.x < left.x + left.width
        && left.y < right.y + right.height && right.y < left.y + left.height;
}

/** Share of `box` covered by `other`. */
function overlapShare(box: Rectangle, other: Rectangle): number {
    const shared = Math.max(0, Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x))
        * Math.max(0, Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y));
    return shared / Math.max(1, box.width * box.height);
}

function withPaper(
    boxes: InpaintBox[],
    bubbles: BubbleData[],
    pageWidth: number,
    pageHeight: number,
): InpaintBox[] {
    // A balloon outline that covers a large part of the page is a bad outline,
    // and clipping a fill to it would paint the whole page with paper. Such a
    // balloon is ignored and the box goes through the inpaint pass instead.
    const pageArea = pageWidth * pageHeight;
    return boxes.map((box) => {
        const centreX = box.x + box.width / 2;
        const centreY = box.y + box.height / 2;
        let balloon: BubbleData | undefined;
        for (const bubble of bubbles) {
            if (centreX < bubble.x || centreX > bubble.x + bubble.width
                || centreY < bubble.y || centreY > bubble.y + bubble.height) continue;
            if (!balloon || bubble.width * bubble.height < balloon.width * balloon.height) {
                balloon = bubble;
            }
        }
        if (!balloon) return { ...box };
        if (balloon.width * balloon.height > pageArea * 0.4) return { ...box };
        // A balloon is always flat filled, never sent to the model. Its own
        // paper tone is used when the sample exists, and white when it does not:
        // a balloon the sampler could not read is still one flat colour, and a
        // generative fill can only guess at it. The balloon's outline is not
        // passed as a clip: the seg outline is coarse (one balloon on the test
        // page came back as a polygon spanning the whole page), and a fill that
        // stopped at a usable one left the bottom of a column on the page. What
        // keeps the fill off the artwork is the tight line box, not the wall.
        return { ...box, paper: balloon.paper ?? [255, 255, 255] };
    });
}

/**
 * Who reads the text. A request can name a reader, but the saved translator is
 * the source of truth, so the popup button, the translation flow and the batch
 * flow all read the same way.
 */
async function resolveOcr(request: DetectRequest): Promise<OcrRequest | undefined> {
    if (request.local) return undefined;
    if (request.ocr) {
        if (request.ocr.provider === 'local') return undefined;
        const named = request.ocr.key.trim();
        if (named.length === 0) return undefined;
        return { provider: request.ocr.provider, key: named };
    }
    const settings = await readSettings();
    const key = settings.deepSeekKey.trim();
    return key.length > 0 ? { provider: 'deepseek', key } : undefined;
}

async function runDetection(request: DetectRequest): Promise<DetectResponse> {
    const imageDataUrl = typeof request.imageDataUrl === 'string' && request.imageDataUrl.length > 0
        ? request.imageDataUrl
        : undefined;
    if (!imageDataUrl && typeof request.imageUrl !== 'string') {
        return { ok: false, error: 'Missing image url.' }
    };

    await ensureOffscreenReady();
    const ocr = await resolveOcr(request);

    // Only a network URL needs the page's referer; data: URLs carry their bytes.
    const withReferer = typeof request.tabPageUrl === 'string'
        && request.tabPageUrl.startsWith('http')
        && /^https?:\/\//i.test(request.imageUrl);
    if (withReferer) {
        await installRefererRule(request.imageUrl, request.tabPageUrl as string);
    }

    try {
        const response = (await chrome.runtime.sendMessage(
            offscreenRequestFactory.ofDetection(request.imageUrl, imageDataUrl, ocr),
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
                // The JSON is what the panel exists for; the crop is a live-only
                // thumbnail, so it is dropped before storing.
                blockReadings: response.blockReadings?.map((reading) => ({
                    block: reading.block,
                    raw: reading.raw,
                    boxes: reading.boxes,
                    regions: reading.regions,
                })),
                groups: response.groups,
                erasedUrl: response.erasedUrl,
                originalUrl: response.originalUrl,
                detUrl: response.detUrl,
                segUrl: response.segUrl,
                ms: response.ms,
                warm: response.warm,
                timings: response.timings,
            };

            // Local storage holds 10 MB. The score maps go first, then the crops
            // are trimmed rather than dropped: a reopened debug view should still
            // show every line, even when only some crops fit.
            const sizeOf = (value: unknown): number => JSON.stringify(value).length;
            const LADDER: ((value: typeof payload) => typeof payload)[] = [
                (value) => value,
                (value) => ({ ...value, detUrl: null, segUrl: null }),
                (value) => ({ ...value, detUrl: null, segUrl: null, previews: value.previews.slice(0, 30) }),
                (value) => ({ ...value, detUrl: null, segUrl: null, previews: value.previews.slice(0, 12) }),
                (value) => ({ ...value, detUrl: null, segUrl: null, previews: [] }),
            ];
            const slim = LADDER.find((step) => sizeOf(step(payload)) <= 5_000_000) ?? LADDER[LADDER.length - 1];
            try {
                await chrome.storage.local.set({ [LAST_RESULT_KEY]: slim(payload) });
            } catch (cause) {
                console.warn('The last result did not fit in session storage.', cause);
                await chrome.storage.local
                    .set({ [LAST_RESULT_KEY]: { ...payload, detUrl: null, segUrl: null, previews: [] } })
                    .catch(() => undefined);
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
        // Maps first, then crops. A page without its crops still lists every
        // line, which is better than a popup that cannot save anything.
        await write(next.map((item) => ({ ...item, detUrl: undefined, segUrl: undefined })))
            .catch(async () => {
                await write(next.map((item) => ({ ...item, detUrl: undefined, segUrl: undefined, previews: [] })))
                    .catch(() => undefined);
            });
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
                previews: [],
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
        TRANSLATOR_KEY,
        FONT_KEY,
        LEADING_KEY,
        WEIGHT_KEY,
        REASONING_EFFORT_KEY,
    ]);
    return {
        translator: 'deepseek',
        deepSeekKey: typeof local[DEEPSEEK_KEY] === 'string' ? local[DEEPSEEK_KEY] : '',
        effort: readEffort(local[REASONING_EFFORT_KEY]),
        font: 'sans',
        leading: 1,
        weight: 'normal',
    };
}

/** A stored level, or the default when the value is missing or unknown. */
function readEffort(value: unknown): ReasoningEffort {
    return REASONING_EFFORTS.find((effort) => effort === value) ?? DEFAULT_REASONING_EFFORT;
}

/**
 * Write each block's translation back into the stored block readings, matching
 * a block to its reading by the box both were built from.
 */
async function assignBlockTranslations(
    groups: { x: number; y: number; width: number; height: number }[],
    answers: { text?: string; columns?: string[] }[],
): Promise<void> {
    const stored = await chrome.storage.local.get([LAST_RESULT_KEY]).catch(() => null);
    const last = stored?.[LAST_RESULT_KEY] as { blockReadings?: { block: { x: number; y: number; width: number; height: number }; translation?: string }[] } | undefined;
    const readings = last?.blockReadings;
    if (!readings) return;
    let changed = false;
    groups.forEach((group, index) => {
        const answer = answers[index];
        const columns = (answer?.columns ?? []).map((column) => column.trim()).filter(Boolean);
        const text = (columns.length > 0 ? columns.join('') : answer?.text ?? '').trim();
        if (text.length === 0) return;
        const reading = readings.find((entry) => (
            Math.abs(entry.block.x - group.x) < 1
            && Math.abs(entry.block.y - group.y) < 1
            && Math.abs(entry.block.width - group.width) < 1
            && Math.abs(entry.block.height - group.height) < 1
        ));
        if (!reading || reading.translation === text) return;
        reading.translation = text;
        changed = true;
    });
    if (changed) {
        await chrome.storage.local.set({ [LAST_RESULT_KEY]: last }).catch(() => undefined);
    }
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
            previews: detection.previews,
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
            signal,
        });

        // The second pass answers per block, and those answers belong to the
        // block that produced them: writing them back is what lets the debug
        // panel show a block's translation next to the text it read.
        await assignBlockTranslations(detection.groups, job.answers);

        let erasedUrl = detection.erasedUrl;
        if (signal?.aborted) throw new Error('Cancelled.');
        if (detection.canInpaint && job.items.length > 0) {
            notifyProgress(tabId, 'inpainting');
            // BLK + DET. A block is the outer limit: nothing outside it is
            // touched, and inside it the det plane says where the text is (see
            // maskOfBlock). A sound effect inside such a block keeps its ink.
            //
            // Two gates stand between the blk box and the eraser:
            //
            // 1. The block must carry a label. A block whose translation failed
            //    or which the translator skipped has no text to paste over its
            //    ink, and erasing it leaves a blank balloon.
            // 2. Only the area the translation covers is erased: this block's
            //    laid-out lines plus its labels. A reader can miss a column the
            //    detector boxed (a name call inside a balloon whose blk box
            //    merged both balloons); that column has no label over it, so a
            //    block-wide erase would empty it.
            const labelled = job.labelled;
            // BLK is the area, DET says which pixels in it are text. The area is
            // the crop the reader was given, not the block box: the crop is the
            // block grown by its margin and by every det box drawn on it, and a
            // column can sit outside the block box and inside that crop — the
            // そうだ of one balloon did, and it was never erased because the
            // block box stopped a few pixels short of it.
            //
            // What is painted inside the area is the det plane, not the area: a
            // block painted whole is a white rectangle across the balloon. See
            // maskOfBlock.
            const areaOf = (reading: { block: { x: number; y: number; width: number; height: number }; boxes?: { x: number; y: number; width: number; height: number }[] }) => {
                const crop = blockCropBox(detection.imageWidth, detection.imageHeight, reading.block, reading.boxes ?? []);
                return crop.width > 0 && crop.height > 0
                    ? { x: crop.x, y: crop.y, width: crop.width, height: crop.height }
                    : null;
            };
            const readable = (detection.blockReadings ?? [])
                .filter((reading) => reading.regions.some((region) => region.kind !== 'sfx' && region.text.trim().length > 0));
            const dialogueBlocks = readable
                .filter((reading) => labelled.some((box) => overlaps(box, reading.block)))
                .map((reading) => ({
                    ...(areaOf(reading) ?? reading.block),
                    kind: 'block' as const,
                    keep: [
                        ...reading.regions
                            .filter((region) => region.kind === 'sfx')
                            .map((region) => ({ x: region.x, y: region.y, width: region.width, height: region.height })),
                        // Lines the translation left out keep their ink.
                        ...job.keep.filter((line) => overlaps(line, reading.block)),
                    ],
                }));
            if (dialogueBlocks.length !== readable.length) {
                console.warn(`[erase] ${readable.length - dialogueBlocks.length} block(s) got no label; their ink stays`);
            }
            // Without block readings (the on-device reader) the translated
            // groups are the erase set. `detection.eraseBoxes` is deliberately
            // not used as the source: it lists every detected line, including
            // lines no group claimed, and only the keep filter stood between
            // those and a blanked page.
            const fallback = readable.length > 0
                ? []
                : job.erase
                    .map((box) => ({ ...box, kind: 'region' as const }))
                    .filter((box) => !job.keep.some((line) => overlapShare(line, box) > 0.5));
            const painted = (await chrome.runtime.sendMessage(
                offscreenRequestFactory.ofInpaint(withPaper([
                    ...dialogueBlocks,
                    ...fallback,
                ], detection.bubbles, detection.imageWidth, detection.imageHeight)),
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
