import { useCallback, useEffect, useRef, useState } from 'react';
import {
    CONTENT_SCRIPT_FILE,
    DEEPSEEK_KEY,
    DETECTION_CACHE_VERSION,
    OCR_MIN_CONFIDENCE,
    POPUP_VIEW_KEY,
    type PopupView,
    LAST_RESULT_KEY,
    DEBUG_PAGES_KEY,
    DEBUG_INDEX_KEY,
    BATCH_STATE_KEY,
    PICKED_IMAGE_TARGET_KEY,
    PICKED_IMAGE_URL_KEY,
    SHOW_TRANSLATION_KEY,
    PICKER_SESSION_ATTRIBUTE,
    REASONING_EFFORT_KEY,
    REASONING_EFFORTS,
    DEFAULT_REASONING_EFFORT,
    type ReasoningEffort,
} from './shared/constants';
import type {
    BatchStatusResponse,
    BlockData,
    BlockReadingData,
    BoxData,
    DebugPage,
    DetectResponse,
    DetectTimings,
} from './shared/types';
import serviceWorkerRequestFactory from './shared/factories/serviceWorkerRequestFactory';
import { setOverlayOpacityInPage } from './shared/overlayVisibility';
import { cropSize } from './lib/warp';
import { blockCropDataUrl, blockCropScale, readerCropBox } from './lib/ocr/blockCrop';
import { gridCell } from './lib/ocr/grid';


type BubbleStroke = {
    x: number;
    y: number;
    width: number;
    height: number;
    outline?: { x: number; y: number }[];
};
type GroupStroke = {
    x: number;
    y: number;
    width: number;
    height: number;
    lines: string[];
    background?: string;
    color?: string;
    maskUrl?: string;
    maskBox?: { x: number; y: number; width: number; height: number };
    rectangle?: boolean;
    fontSize?: number;
    vertical?: boolean;
    balloon?: boolean;
};
function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)} s`;
}

function formatShortcut(value: string, platform: 'mac' | 'windows'): string {
    const tokens = value.split('+').filter((part) => part.length > 0).map((part) => {
        if (part === 'Alt') return platform === 'mac' ? 'Opt' : 'Alt';
        if (part === 'Command') return '⌘';
        if (part === 'Ctrl' || part === 'MacCtrl') return platform === 'mac' ? '⌃' : 'Ctrl';
        if (part === 'Shift') return '⇧';
        return part;
    });
    return tokens.reduce((text, token) => {
        if (text.length === 0) return token;
        return /[A-Za-z]$/.test(text) ? `${text}+${token}` : `${text}${token}`;
    }, '');
}

function ocrScore(value: number | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'score n/a';
    return `score ${(value * 100).toFixed(0)}%`;
}

function prettyJson(raw: string): string {
    if (!raw) return 'no answer';
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
        return raw;
    }
}

function stageBreakdown(timings?: DetectTimings): string {
    if (!timings) return '';
    return `detect ${seconds(timings.detect)}, OCR ${seconds(timings.ocr)}, bubbles ${seconds(timings.bubble)}`;
}

function stageSummary(timings?: DetectTimings): string {
    const breakdown = stageBreakdown(timings);
    return breakdown.length > 0 ? `; ${breakdown}` : '';
}

type LastResult = {
    version?: string;
    imageUrl: string;
    boxes: BoxData[];
    previews?: string[];
    bubbles?: BubbleStroke[];
    /** The blk boxes, which are the crops the reader was given. */
    blocks?: BlockData[];
    blockReadings?: BlockReadingData[];
    groups?: GroupStroke[];
    detUrl?: string | null;
    segUrl?: string | null;
    ms: number;
    warm?: boolean;
    timings?: DetectTimings;
};


/**
 * Whether the document that was picked from still exists. The picker marks the
 * document element, and a reload replaces the DOM, so a missing mark means every
 * stored box belongs to a page that is gone.
 */
async function pickedDocumentAlive(): Promise<boolean | null> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    if (!tab?.id) return null;
    try {
        const frames = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            args: [PICKER_SESSION_ATTRIBUTE],
            func: (attribute: string) => document.documentElement.hasAttribute(attribute),
        });
        return frames.some((frame) => frame.result === true);
    } catch {
        // A restricted page cannot answer, which is not the same as a reload.
        return null;
    }
}

export default function App() {
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [boxes, setBoxes] = useState<BoxData[]>([]);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [status, setStatus] = useState('No image picked yet.');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [bubbles, setBubbles] = useState<BubbleStroke[]>([]);
    const [blocks, setBlocks] = useState<BlockData[]>([]);
    const [blockReadings, setBlockReadings] = useState<BlockReadingData[]>([]);
    const [blockThumbs, setBlockThumbs] = useState<Record<number, string>>({});
    /** The rectangle actually cut for each block, in page pixels. */
    const [blockCrops, setBlockCrops] = useState<Record<number, { x: number; y: number; width: number; height: number; cell: number }>>({});
    const [groups, setGroups] = useState<GroupStroke[]>([]);
    const [deepSeekKey, setDeepSeekKey] = useState('');
    const [effort, setEffort] = useState<ReasoningEffort>(DEFAULT_REASONING_EFFORT);
    const [dirty, setDirty] = useState(false);
    const [view, setView] = useState<PopupView>('production');
    const [translationVisible, setTranslationVisible] = useState(true);
    const [runningBatchId, setRunningBatchId] = useState<string | null>(null);
    const [terminating, setTerminating] = useState(false);
    const [debugPages, setDebugPages] = useState<DebugPage[]>([]);
    const [debugIndex, setDebugIndex] = useState(0);
    const [detUrl, setDetUrl] = useState<string | null>(null);
    const [segUrl, setSegUrl] = useState<string | null>(null);
    const debugIndexRef = useRef(0);

    const applyOverlayOpacity = useCallback(async (visible: boolean): Promise<void> => {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) return;
            await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                world: 'ISOLATED',
                args: [visible ? 1 : 0],
                func: setOverlayOpacityInPage,
            });
        } catch {
            // A tab without the overlay helper has no translation to hide.
        }
    }, []);

    const handleTranslationToggle = useCallback(() => {
        const next = !translationVisible;
        setTranslationVisible(next);
        void chrome.storage.local.set({ [SHOW_TRANSLATION_KEY]: next });
        void applyOverlayOpacity(next);
    }, [applyOverlayOpacity, translationVisible]);

    const handleTerminateBatch = useCallback(() => {
        if (!runningBatchId || terminating) return;
        setTerminating(true);
        void chrome.runtime.sendMessage(serviceWorkerRequestFactory.ofCancel(runningBatchId))
            .finally(() => setTerminating(false));
    }, [runningBatchId, terminating]);

    useEffect(() => {
        let stopped = false;
        const ping = () => {
            void chrome.runtime.sendMessage(serviceWorkerRequestFactory.ofBatchStatus())
                .then((response: BatchStatusResponse | undefined) => {
                    if (stopped) return;
                    setRunningBatchId(response?.running && response.batchId ? response.batchId : null);
                })
                .catch(() => undefined);
        };
        ping();
        const timer = window.setInterval(ping, 1000);
        return () => {
            stopped = true;
            window.clearInterval(timer);
        };
    }, []);

    const setViewRemembered = useCallback((next: PopupView) => {
        setView(next);
        void chrome.storage.session.set({ [POPUP_VIEW_KEY]: next });
    }, []);
    const [activeShortcut, setActiveShortcut] = useState('Alt+T');

    useEffect(() => {
        // Both tabs render in the toolbar popup. Chrome caps a popup at 800x600,
        // so the wider debug view scrolls inside that box.
        const debug = view === 'debug';
        document.body.style.width = debug ? '720px' : '320px';
        document.body.style.maxHeight = debug ? '600px' : 'none';
        document.body.style.height = '';
        document.body.style.overflowY = debug ? 'auto' : 'visible';
    }, [view]);
    const settingsLoaded = useRef(false);

    const showDebugPage = useCallback((pages: DebugPage[], index: number) => {
        const page = pages[index];
        if (!page) return;
        debugIndexRef.current = index;
        setDebugIndex(index);
        // Remember which page the popup was inspecting. Session storage is
        // cleared when Chrome exits, so a new browser session starts at page 1.
        void chrome.storage.session.set({ [DEBUG_INDEX_KEY]: index }).catch(() => undefined);
        const loadable = page.imageUrl.startsWith('http') || page.imageUrl.startsWith('data:');
        setImageUrl(loadable ? page.imageUrl : null);
        setBoxes(page.boxes);
        setBubbles(page.bubbles ?? []);
        setBlocks(page.blocks ?? []);
        setBlockReadings([]);
        setGroups(page.groups ?? []);
        setDetUrl(page.detUrl ?? null);
        setSegUrl(page.segUrl ?? null);
        setSize({ width: 0, height: 0 });
        setStatus(page.ready
            ? `Page ${index + 1} of ${pages.length}: ${page.boxes.length} boxes (${seconds(page.ms)}${stageSummary(page.timings)}).`
            : `Page ${index + 1} of ${pages.length}: waiting for detection.`);
    }, []);

    useEffect(() => {
        // start working when we open this popup again,
        // at this point our newly picked image url is nonempty.
        Promise.all([
            chrome.storage.local.get([
                PICKED_IMAGE_URL_KEY,
                PICKED_IMAGE_TARGET_KEY,
                DEEPSEEK_KEY,
                REASONING_EFFORT_KEY,
                                        LAST_RESULT_KEY,
                DEBUG_PAGES_KEY,
                SHOW_TRANSLATION_KEY,
            ]),
            chrome.storage.session.get([POPUP_VIEW_KEY, DEBUG_INDEX_KEY]),
        ])
            .then(async ([local, session]) => {
                const pickedImageUrl = local[PICKED_IMAGE_URL_KEY];
                const storedDeepSeek = local[DEEPSEEK_KEY];
                if (typeof storedDeepSeek === 'string') setDeepSeekKey(storedDeepSeek);
                const storedEffort = local[REASONING_EFFORT_KEY];
                const level = REASONING_EFFORTS.find((value) => value === storedEffort);
                if (level) setEffort(level);
                const storedView = session[POPUP_VIEW_KEY];
                if (storedView === 'production' || storedView === 'debug') {
                    setView(storedView);
                }
                const storedVisible = local[SHOW_TRANSLATION_KEY];
                const visible = storedVisible !== false;
                setTranslationVisible(visible);
                if (!visible) void applyOverlayOpacity(false);
                settingsLoaded.current = true;
                const hasStored = (typeof pickedImageUrl === 'string' && pickedImageUrl.length > 0)
                    || (Array.isArray(local[DEBUG_PAGES_KEY]) && (local[DEBUG_PAGES_KEY] as unknown[]).length > 0)
                    || Boolean(local[LAST_RESULT_KEY]);
                if (hasStored && (await pickedDocumentAlive()) === false) {
                    // The page reloaded or navigated away. Drop the pick and every
                    // box that described the old document, so the popup starts
                    // empty instead of showing a result nothing on screen matches.
                    await chrome.storage.local.remove([
                        PICKED_IMAGE_URL_KEY,
                        PICKED_IMAGE_TARGET_KEY,
                        LAST_RESULT_KEY,
                        DEBUG_PAGES_KEY,
                    ]).catch(() => undefined);
                    await chrome.storage.session.remove(DEBUG_INDEX_KEY).catch(() => undefined);
                    setImageUrl(null);
                    setBoxes([]);
                    setBubbles([]);
                    setBlocks([]);
                    setBlockReadings([]);
                    setGroups([]);
                    setDebugPages([]);
                    setDetUrl(null);
                    setSegUrl(null);
                    setStatus('No image picked yet.');
                    return;
                }
                const storedPages = local[DEBUG_PAGES_KEY];
                const pages = Array.isArray(storedPages) ? storedPages as DebugPage[] : [];
                const picked = typeof pickedImageUrl === 'string' ? pickedImageUrl : '';
                // A stored batch belongs to the pick that started it. Showing it
                // for a newer pick prints another page's text over this image.
                const fromThisPick = picked.length === 0 || pages.some((page) => page.imageUrl === picked);
                if (pages.length > 1 && fromThisPick) {
                    setDebugPages(pages);
                    // Reopen on the page that was being inspected, but a fresh
                    // batch can be shorter than the one that saved the index.
                    const storedIndex = session[DEBUG_INDEX_KEY];
                    const index = typeof storedIndex === 'number' && Number.isInteger(storedIndex)
                        ? Math.min(Math.max(storedIndex, 0), pages.length - 1)
                        : 0;
                    showDebugPage(pages, index);
                    return;
                }
                if (pages.length > 0 && !fromThisPick) {
                    setDebugPages([]);
                    void chrome.storage.local.remove(DEBUG_PAGES_KEY).catch(() => undefined);
                }
                const lastResult = local[LAST_RESULT_KEY] as LastResult | undefined;

                if (typeof pickedImageUrl !== 'string' || pickedImageUrl.length === 0) {
                    return;
                }

                setImageUrl(pickedImageUrl);

                // don't do it again if we pick the same image
                const fresh = lastResult?.version === DETECTION_CACHE_VERSION;
                if (fresh && lastResult.imageUrl === pickedImageUrl && Array.isArray(lastResult.boxes)) {
                    setBoxes(lastResult.boxes);
                    setBubbles(Array.isArray(lastResult.bubbles) ? lastResult.bubbles : []);
                    // The blk boxes are the detection, so a restored page draws
                    // them and shows the block cards that go with them.
                    setBlocks(Array.isArray(lastResult.blocks) ? lastResult.blocks : []);
                    setBlockReadings(Array.isArray(lastResult.blockReadings) ? lastResult.blockReadings : []);
                    setGroups(Array.isArray(lastResult.groups) ? lastResult.groups : []);
                    setDetUrl(lastResult.detUrl ?? null);
                    setSegUrl(lastResult.segUrl ?? null);
                    const previousRun = lastResult.warm === undefined
                        ? 'previous run'
                        : `previous ${lastResult.warm ? 'warm' : 'cold'} run`;
                    setStatus(
                        `Restored ${lastResult.boxes.length} boxes from the ${previousRun} (${seconds(lastResult.ms)}${stageSummary(lastResult.timings)}). Translate reuses it.`,
                    );
                    return;
                }

                setStatus('Picked from the page. Run the detector to find boxes.');
            })
            .catch(() => setError('Cannot read the stored state.'));
    }, [showDebugPage]);

    useEffect(() => {
        const onChange = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
            if (areaName !== 'local') return;
            // The picker menu writes the same flag as the switch, so follow it
            // here instead of showing a state the page no longer has.
            const show = changes[SHOW_TRANSLATION_KEY];
            if (show) setTranslationVisible(show.newValue !== false);
            const debug = changes[DEBUG_PAGES_KEY];
            if (!debug) return;
            const next = debug.newValue;
            if (!Array.isArray(next) || next.length < 2) {
                if (Array.isArray(next)) setDebugPages(next as DebugPage[]);
                return;
            }
            const pages = next as DebugPage[];
            setDebugPages(pages);
            const index = Math.min(debugIndexRef.current, pages.length - 1);
            showDebugPage(pages, index);
        };
        chrome.storage.onChanged.addListener(onChange);
        return () => chrome.storage.onChanged.removeListener(onChange);
    }, [showDebugPage]);

    const handlePick = useCallback(async () => {
        setError(null);
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) throw new Error('There is no active tab.');
            // The previous overlay may live in a frame that the picker itself
            // cannot reach. Clear every frame before the new pick starts.
            await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                world: 'ISOLATED',
                func: () => {
                    const api = (globalThis as unknown as {
                        __comicTranslatorOverlay?: { clear: () => void };
                    }).__comicTranslatorOverlay;
                    if (api) api.clear();
                },
            }).catch(() => undefined);
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: [CONTENT_SCRIPT_FILE],
            });
            const started = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: 'ISOLATED',
                func: () => {
                    const picker = (globalThis as unknown as {
                        __comicTranslatorPicker?: { start: () => boolean };
                    }).__comicTranslatorPicker;
                    if (!picker) return false;
                    return picker.start();
                },
            });
            if (!started[0]?.result) throw new Error('The image picker did not start on this page.');
            window.close();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }, []);

    const runDetect = useCallback(async (): Promise<DetectResponse | null> => {
        if (!imageUrl) return null;
        setBusy(true);
        setError(null);
        setBoxes([]);
        setDetUrl(null);
        setSegUrl(null);
        setStatus('Asking the background worker.');

        try {
            const tabPageUrl = await getCurrentPageUrl();
            const response = await sendDetectionRequestToServiceWorker(tabPageUrl, imageUrl);

            if (!response) throw new Error('The background worker sent no answer.');
            if (!response.ok) throw new Error(response.error);

            setBoxes(response.boxes);
            setBlocks(response.blocks ?? []);
            setBlockReadings(response.blockReadings ?? []);
            // The debug client falls back to a stored batch on reopen, and that
            // batch is about a different image now.
            setDebugPages([]);
            void chrome.storage.local.remove(DEBUG_PAGES_KEY).catch(() => undefined);
            setBubbles(response.bubbles ?? []);
            setGroups(response.groups ?? []);
            setDetUrl(response.detUrl);
            setSegUrl(response.segUrl);
            const vertical = response.boxes.filter((box) => box.direction === 'vertical').length;
            const ruby = response.boxes.reduce((sum, box) => sum + box.ruby.length, 0);
            const read = response.boxes.filter((box) => box.text.length > 0).length;
            const lowConfidence = response.boxes.filter((box) =>
                box.text.length > 0 && box.confidence < OCR_MIN_CONFIDENCE,
            ).length;
            const cloudLines = response.ocrCloudLines ?? 0;
            const reader = cloudLines > 0
                ? `, read by ${response.ocrProvider} (${cloudLines} regions)`
                : '';
            setStatus(
                `${response.boxes.length} lines (${vertical} vertical, ${ruby} ruby), ${read} read (${lowConfidence} below OCR floor${reader}), ${response.bubbles?.length ?? 0} balloons, ${response.groupedLines} grouped, image ${response.imageWidth}x${response.imageHeight}, ${seconds(response.ms)} (${response.warm ? 'reused session' : 'cold session'}${stageSummary(response.timings)}).`,
            );
            return response;
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setStatus('Detection failed.');
            return null;
        } finally {
            setBusy(false);
        }

        /**
          * Dispatch to service worker
          */
        async function sendDetectionRequestToServiceWorker(
            tabPageUrl: string | undefined,
            targetImageUrl: string
        ) {
            if (!targetImageUrl) {
                return
            }

            // handled in src/background/index.ts, which resolves the reader from
            // the saved translator, so every detect path reads the same way.
            const request = serviceWorkerRequestFactory.ofDetection(targetImageUrl, tabPageUrl);
            const response = (await chrome.runtime.sendMessage(request)) as DetectResponse | undefined;
            return response;
        }

        async function getCurrentPageUrl() {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const pageUrl = tab?.url?.startsWith('http') ? tab.url : undefined;
            return pageUrl;
        }
    }, [imageUrl]);

    const handleDetect = useCallback(async () => {
        await runDetect();
    }, [runDetect]);

    const handleResetAll = useCallback(async () => {
        setError(null);
        try {
            await chrome.storage.local.remove([
                LAST_RESULT_KEY,
                DEBUG_PAGES_KEY,
                PICKED_IMAGE_URL_KEY,
                PICKED_IMAGE_TARGET_KEY,
                BATCH_STATE_KEY,
            ]);
            // The remembered debug page belongs to the results just cleared.
            await chrome.storage.session.remove(DEBUG_INDEX_KEY).catch(() => undefined);
            setDebugPages([]);
            setDebugIndex(0);
            debugIndexRef.current = 0;
            setImageUrl(null);
            setBoxes([]);
                setBubbles([]);
            setBlocks([]);
            setBlockReadings([]);
            setGroups([]);
            setDetUrl(null);
            setSegUrl(null);
            setSize({ width: 0, height: 0 });
            setStatus('Cleared all saved results.');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }, []);

    useEffect(() => {
        void chrome.commands.getAll().then((commands) => {
            const pick = commands.find((entry) => entry.name === 'pick-image');
            if (pick?.shortcut) setActiveShortcut(pick.shortcut);
        }).catch(() => undefined);
    }, []);

    // The effort is saved the moment it changes, unlike the key, which is only
    // written when the user says so. A level that had to be saved by hand is a
    // level the next popup forgets.
    const handleEffortChange = useCallback(async (level: ReasoningEffort) => {
        setEffort(level);
        try {
            await chrome.storage.local.set({ [REASONING_EFFORT_KEY]: level });
            setStatus(`Thinking effort set to ${level === 'off' ? 'off' : level}.`);
        } catch (cause) {
            setError(`Could not save the thinking effort: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
    }, []);

    const handleSaveSettings = useCallback(async () => {
        try {
            await chrome.storage.local.set({

                [DEEPSEEK_KEY]: deepSeekKey.trim(),
                [REASONING_EFFORT_KEY]: effort,

            });
            setDirty(false);
            setStatus('Settings saved.');
        } catch (cause) {
            setError(`Could not save settings: ${cause instanceof Error ? cause.message : String(cause)}`);
            setDirty(true);
        }
    }, [deepSeekKey, effort]);

    const handleDownloadImage = useCallback(() => {
        if (!imageUrl) return;
        let name = 'comic-image';
        // A captured pick is a data: URL, which has no path to name after.
        if (!imageUrl.startsWith('data:')) {
            try {
                name = decodeURIComponent(new URL(imageUrl).pathname.split('/').pop() || name);
            } catch {
                // Keep the fallback name for unusual image URLs.
            }
        }
        chrome.downloads.download({ url: imageUrl, filename: name, saveAs: true }, (id) => {
            if (chrome.runtime.lastError || id === undefined) {
                setError(chrome.runtime.lastError?.message ?? 'Could not start the image download.');
            }
        });
    }, [imageUrl]);

    // The blocks are the detection now, so the debug view shows the crops the
    // reader was given: the BLK box with its margin, upscaled, grid drawn. The
    // stored answer does not carry those images, so the popup cuts the same
    // crop here, with the same code the offscreen pass uses.
    useEffect(() => {
        setBlockThumbs({});
        if (!imageUrl || blocks.length === 0) return;
        let cancelled = false;
        void (async () => {
            const image = await new Promise<HTMLImageElement>((resolve, reject) => {
                const element = new Image();
                element.crossOrigin = 'anonymous';
                element.onload = () => resolve(element);
                element.onerror = () => reject(new Error('The page image did not load.'));
                element.src = imageUrl;
            }).catch(() => null);
            if (!image || cancelled) return;
            const thumbs: Record<number, string> = {};
            blocks.forEach((block, index) => {
                try {
                    thumbs[index] = blockCropDataUrl(
                        image,
                        image.naturalWidth,
                        image.naturalHeight,
                        block,
                        blockReadings[index]?.boxes ?? [],
                    ).dataUrl;
                } catch {
                    // A refused canvas leaves the card without a crop.
                }
            });
            if (!cancelled) setBlockThumbs(thumbs);
        })();
        return () => {
            cancelled = true;
        };
    }, [blocks, blockReadings, imageUrl]);

    // The crop rectangle is geometry only: the blk box with its margin, grown
    // to hold every box drawn on it, clamped to the page. Computing it from the
    // page size keeps the coordinate visible even when the thumbnail cannot be
    // cut (a cross-origin image refuses the canvas).
    useEffect(() => {
        if (size.width <= 0 || size.height <= 0 || blocks.length === 0) {
            setBlockCrops({});
            return;
        }
        const crops: Record<number, { x: number; y: number; width: number; height: number; cell: number }> = {};
        blocks.forEach((block, index) => {
            const crop = readerCropBox(size.width, size.height, block, blockReadings[index]?.boxes ?? []);
            crops[index] = { ...crop, cell: gridCell(crop, blockCropScale(crop)) };
        });
        setBlockCrops(crops);
    }, [blocks, blockReadings, size.width, size.height]);

    const handleDownloadCombined = useCallback(async () => {
        if (!imageUrl) return;
        try {
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            if (!context) throw new Error('The browser refused a 2D context.');

            const page = await createImageBitmap(await (await fetch(imageUrl)).blob());
            canvas.width = size.width > 0 ? size.width : page.width;
            canvas.height = size.height > 0 ? size.height : page.height;
            context.drawImage(page, 0, 0, canvas.width, canvas.height);

            // The same diagnostics the preview stacks over the page: DET, then SEG.
            const paintMap = async (url: string): Promise<void> => {
                const map = await createImageBitmap(await (await fetch(url)).blob());
                context.drawImage(map, 0, 0, canvas.width, canvas.height);
            };
            if (detUrl) await paintMap(detUrl);
            if (segUrl) await paintMap(segUrl);

            // Keep the strokes legible when the page itself is large.
            const scale = Math.max(1, canvas.width / 720);
            context.save();
            context.setLineDash([6 * scale, 4 * scale]);
            context.strokeStyle = '#2f7bd8';
            context.lineWidth = scale;
            for (const bubble of bubbles) {
                context.strokeRect(bubble.x, bubble.y, bubble.width, bubble.height);
            }
            context.restore();

            // Blocks from the blk head, in yellow: the region-level boxes the
            // model proposes before any line is recognised.
            if (blocks.length > 0) {
                context.save();
                context.strokeStyle = '#e6b800';
                context.lineWidth = scale * 2;
                for (const block of blocks) {
                    context.strokeRect(block.x, block.y, block.width, block.height);
                }
                context.restore();
            }

            // The rectangle actually cut for the reader, in the same violet the
            // preview uses: the blk box with its margin, grown to hold every
            // box drawn on the crop.
            const cuts = Object.values(blockCrops);
            if (cuts.length > 0) {
                context.save();
                context.setLineDash([3 * scale, 3 * scale]);
                context.strokeStyle = '#7c3aed';
                context.lineWidth = scale;
                for (const crop of cuts) {
                    context.strokeRect(crop.x, crop.y, crop.width, crop.height);
                }
                context.restore();
            }

            // The detector's line boxes, in the same blue the reader's crop
            // carries them, so the picture matches what was sent.
            context.save();
            context.strokeStyle = '#1d4ed8';
            context.lineWidth = scale;
            for (const reading of blockReadings) {
                for (const box of reading.boxes ?? []) {
                    context.strokeRect(box.x, box.y, box.width, box.height);
                }
            }
            context.restore();

            // Same colours as the preview: horizontal lines blue, vertical red.
            for (const box of boxes) {
                const { width, height } = cropSize(box);
                const horizontal = box.direction === 'horizontal';
                context.save();
                context.translate(box.x + box.width / 2, box.y + box.height / 2);
                if (box.angle) context.rotate(box.angle);
                context.fillStyle = horizontal ? 'rgba(47,123,216,0.12)' : 'rgba(255,77,109,0.12)';
                context.strokeStyle = horizontal ? '#2f7bd8' : '#ff4d6d';
                context.lineWidth = scale;
                context.fillRect(-width / 2, -height / 2, width, height);
                context.strokeRect(-width / 2, -height / 2, width, height);
                context.restore();
            }

            const blob = await new Promise<Blob>((resolve, reject) => {
                canvas.toBlob((result) => {
                    if (result) resolve(result);
                    else reject(new Error('The browser refused to encode the combined image.'));
                }, 'image/jpeg', 0.92);
            });
            const blobUrl = URL.createObjectURL(blob);
            let base = 'comic-page';
            if (!imageUrl.startsWith('data:')) {
                try {
                    const fromUrl = decodeURIComponent(new URL(imageUrl).pathname.split('/').pop() || '');
                    base = fromUrl.replace(/\.[^.]+$/, '') || base;
                } catch {
                    // Keep the fallback name for unusual image URLs.
                }
            }
            const name = `${base}-combined.jpg`;
            await new Promise<void>((resolve, reject) => {
                chrome.downloads.download({ url: blobUrl, filename: name, saveAs: true }, (id) => {
                    const message = chrome.runtime.lastError?.message;
                    if (message || id === undefined) reject(new Error(message ?? 'Could not start the combined download.'));
                    else resolve();
                });
            });
            window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
            setStatus(`Saved the page with det, seg, ${blocks.length} blocks, their crop rectangles and ${boxes.length} boxes drawn on it as ${name}.`);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }, [blocks, blockCrops, blockReadings, bubbles, boxes, detUrl, imageUrl, segUrl, size.height, size.width]);

    const onMac = /Mac|iPhone|iPad/i.test(navigator.userAgent);
    const macShortcut = onMac ? formatShortcut(activeShortcut, 'mac') : 'Opt+T';
    const windowsShortcut = onMac ? 'Alt+T' : formatShortcut(activeShortcut, 'windows');

    return (
        <main className={`mx-auto flex flex-col gap-3 rounded-md bg-[#f4f1ec] p-3 text-slate-900 transition-[width] duration-200 ease-out ${view === 'debug' ? 'w-[720px]' : 'w-[320px]'}`}>
            <div className="flex flex-col items-start gap-2">
                <div className="flex w-full items-center justify-between gap-2">
                    <div className="flex rounded-md bg-[#e9e3da] p-1">
                        <button
                            type="button"
                            onClick={() => setViewRemembered('production')}
                            className={`rounded px-3 py-1.5 text-xs font-medium transition ${view === 'production' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                        >
                            Settings
                        </button>
                        <button
                            type="button"
                            onClick={() => setViewRemembered('debug')}
                            className={`rounded px-3 py-1.5 text-xs font-medium transition ${view === 'debug' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                        >
                            Debug Client
                        </button>
                    </div>
                    <span className="shrink-0 rounded bg-[#ece4d9] px-2.5 py-1 text-xs font-medium text-[#7a5c43]">v1.1.2</span>
                </div>
                <div className="flex w-full flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-[#6d523b]">Translation</span>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={translationVisible}
                        aria-label="Show the translated page"
                        title={translationVisible ? 'Hide the translation and show the original page' : 'Show the translation over the page'}
                        onClick={handleTranslationToggle}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full border transition ${translationVisible ? 'border-[#a5724f] bg-[#b3815c]' : 'border-[#cbbead] bg-[#dcd3c7]'}`}
                    >
                        <span
                            className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${translationVisible ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
                        />
                    </button>
                    <span className={`w-5 text-xs font-medium ${translationVisible ? 'text-[#7a5c43]' : 'text-slate-400'}`}>
                        {translationVisible ? 'On' : 'Off'}
                    </span>
                    {runningBatchId ? (
                        <button
                            type="button"
                            onClick={handleTerminateBatch}
                            disabled={terminating}
                            className="ml-1 rounded border border-[#ded2c4] bg-white px-2 py-0.5 text-xs font-medium text-[#7a5c43] transition hover:bg-[#f3eee8] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {terminating ? 'Stopping queue…' : 'Stop queue'}
                        </button>
                    ) : null}
                    <button
                        type="button"
                        onClick={handleResetAll}
                        className="ml-auto shrink-0 whitespace-nowrap rounded border border-[#ded2c4] bg-white px-2.5 py-1 text-xs font-medium text-[#7a5c43] transition hover:bg-[#f3eee8]"
                    >
                        Clear results
                    </button>
                </div>
            </div>

            <header>
                <h1 className="text-base font-semibold tracking-tight">Comic Translator</h1>
                <p className="mt-1 text-sm leading-5 text-slate-600">{status}</p>

                {view === 'production' ? (
                <section className="mt-3 rounded-md border border-[#e7dfd4] bg-[#fbf8f4] p-3">
                    <div className="flex items-center justify-between gap-3">
                        <h2 className="text-sm font-semibold">API Key Settings</h2>
                        {dirty ? (
                            <button
                                type="button"
                                onClick={handleSaveSettings}
                                className="rounded border border-[#9f6f4d] bg-[#b3815c] px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-[#a5724f] active:translate-y-px"
                            >
                                Save settings
                            </button>
                        ) : (
                            <div className="inline-flex items-center gap-1.5 rounded bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                Saved
                            </div>
                        )}
                    </div>

                    <div className="mt-2 flex flex-col gap-2">
                        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                            DeepSeek API key
                            <input
                                type="password"
                                value={deepSeekKey}
                                placeholder="sk-..."
                                onChange={(event) => {
                                    setDeepSeekKey(event.target.value);
                                    setDirty(true);
                                }}
                                className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#b08a68] focus:ring-2 focus:ring-[#eadfd2]"
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                            Translation effort
                            <select
                                value={effort}
                                onChange={(event) => {
                                    const level = REASONING_EFFORTS.find((value) => value === event.target.value);
                                    if (level) void handleEffortChange(level);
                                }}
                                className="rounded border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 outline-none transition focus:border-[#b08a68] focus:ring-2 focus:ring-[#eadfd2]"
                            >
                                <option value="off">Off (default), answer immediately</option>
                                <option value="low">Low</option>
                                <option value="high">High</option>
                                <option value="max">Max</option>
                            </select>
                        </label>
                        <p className="text-[11px] font-medium text-[#8a6a4f]">
                            Reading a block never thinks: it transcribes the text and places it. This level is the
                            translation that follows, one request per block, with the rest of the page as context.
                            Off is the default: the prompt carries the procedure a chain of thought would perform,
                            and thinking was the wall-clock cost of a page. High and max buy a harder look at a
                            block at the cost of waiting.
                        </p>
                        <p className="text-[11px] font-medium text-[#8a6a4f]">
                            DeepSeek reads each block and writes its translation. Without a key no translation runs.
                        </p>
                    </div>
                </section>
                ) : null}

                {view === 'debug' ? (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            onClick={handlePick}
                            className="rounded bg-[#b3815c] px-3 py-2 text-sm font-medium text-white transition hover:bg-[#a5724f] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            Pick an image
                        </button>
                        <button
                            type="button"
                            onClick={handleDetect}
                            disabled={!imageUrl || busy}
                            data-busy={busy}
                            title={imageUrl ? undefined : 'Pick an image on the page first.'}
                            className="rounded bg-[#b3815c] px-3 py-2 text-sm font-medium text-white transition hover:bg-[#a5724f] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {busy ? 'Detecting...' : 'Detect boxes'}
                        </button>
                    </div>
                ) : (
                    <div className="mt-3 space-y-1 rounded-md border border-[#ded2c4] bg-[#f3eee8] px-3 py-2 text-sm text-[#5f4a38]">
                        <p>
                            Press{' '}
                            <kbd className="rounded border border-[#ded2c4] bg-white px-1.5 py-0.5 font-mono text-xs text-[#6d523b]">{macShortcut}</kbd>
                            {' '}on Mac, or{' '}
                            <kbd className="rounded border border-[#ded2c4] bg-white px-1.5 py-0.5 font-mono text-xs text-[#6d523b]">{windowsShortcut}</kbd>
                            {' '}on Windows, then drag to select images.
                        </p>
                        <p>
                            Right-click an image with the picker on and choose{' '}
                            <span className="font-medium">Show/Hide Translation</span>.
                            It stays greyed out until the page has a translation.
                        </p>
                    </div>
                )}
            </header>

            {error ? (
                <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                    {error}
                </div>
            ) : null}


            {imageUrl || (view === 'debug' && debugPages.length > 1) ? (
                <section className={`rounded-md border border-[#e7dfd4] bg-white p-3 shadow-sm ${view === 'debug' ? '' : 'hidden'}`}>
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <h2 className="shrink-0 whitespace-nowrap text-sm font-semibold">Page preview</h2>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                            {view === 'debug' && debugPages.length > 1 ? (
                                <div className="flex items-center gap-1">
                                    <button
                                        type="button"
                                        disabled={debugIndex <= 0}
                                        onClick={() => showDebugPage(debugPages, debugIndex - 1)}
                                        className="rounded border border-[#ded2c4] bg-white px-2 py-1 text-xs font-medium text-[#6d523b] transition hover:bg-[#f3eee8] disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                        Previous
                                    </button>
                                    <span className="min-w-12 text-center text-xs text-slate-500">{debugIndex + 1} / {debugPages.length}</span>
                                    <button
                                        type="button"
                                        disabled={debugIndex >= debugPages.length - 1}
                                        onClick={() => showDebugPage(debugPages, debugIndex + 1)}
                                        className="rounded border border-[#ded2c4] bg-white px-2 py-1 text-xs font-medium text-[#6d523b] transition hover:bg-[#f3eee8] disabled:cursor-not-allowed disabled:opacity-40"
                                    >
                                        Next
                                    </button>
                                </div>
                            ) : null}
                            {detUrl || segUrl ? (
                                <span className="flex items-center gap-2">
                                    {detUrl ? <span className="map-key det"><i />DET</span> : null}
                                    {segUrl ? <span className="map-key seg"><i />SEG</span> : null}
                                </span>
                            ) : null}
                            {blocks.length > 0 ? <span className="map-key blk"><i />BLK</span> : null}
                            {blocks.length > 0 && Object.keys(blockCrops).length > 0
                                ? <span className="map-key crop"><i />CROP</span>
                                : null}
                            {blockReadings.some((reading) => (reading.boxes ?? []).length > 0)
                                ? <span className="map-key line"><i />TEXT</span>
                                : null}
                            <span className="whitespace-nowrap text-xs text-slate-500">{boxes.length} boxes{blocks.length > 0 ? `, ${blocks.length} blocks` : ''}</span>
                            <button
                                type="button"
                                onClick={handleDownloadImage}
                                className="whitespace-nowrap rounded border border-[#ded2c4] bg-white px-2 py-1 text-xs font-medium text-[#6d523b] transition hover:bg-[#f3eee8]"
                            >
                                Download image
                            </button>
                            <button
                                type="button"
                                onClick={() => void handleDownloadCombined()}
                                disabled={!imageUrl || (boxes.length === 0 && !detUrl && !segUrl)}
                                title="Download this page with the det map, the seg map, the blk blocks, their crop rectangles and every box drawn on it (JPEG)."
                                className="whitespace-nowrap rounded border border-[#ded2c4] bg-white px-2 py-1 text-xs font-medium text-[#6d523b] transition hover:bg-[#f3eee8] disabled:cursor-not-allowed disabled:opacity-40"
                            >
                                Download combined
                            </button>
                        </div>
                    </div>
                    {imageUrl ? <div className="stage" key={`${debugIndex}-${imageUrl}`}>
                        <img
                            src={imageUrl}
                            alt="Picked from the page"
                            onLoad={(event) =>
                                setSize({
                                    width: event.currentTarget.naturalWidth,
                                    height: event.currentTarget.naturalHeight,
                                })
                            }
                        />
                        {detUrl ? <img src={detUrl} alt="" className="map map-det" /> : null}
                        {segUrl ? <img src={segUrl} alt="" className="map map-seg" /> : null}
                        {size.width > 0
                            ? Object.entries(blockCrops).map(([index, crop]) => (
                                <span
                                    key={`crop-${index}-${crop.x}-${crop.y}`}
                                    className="crop-box"
                                    title={`CROP ${Math.round(crop.x)},${Math.round(crop.y)} ${Math.round(crop.width)}×${Math.round(crop.height)} (page pixels), ${(blockReadings[Number(index)]?.boxes ?? []).length} box(es) drawn`}
                                    style={{
                                        left: `${(crop.x / size.width) * 100}%`,
                                        top: `${(crop.y / size.height) * 100}%`,
                                        width: `${(crop.width / size.width) * 100}%`,
                                        height: `${(crop.height / size.height) * 100}%`,
                                    }}
                                />
                            ))
                            : null}
                        {blocks.map((block, index) => (
                            <span
                                key={`block-${index}-${block.x}-${block.y}`}
                                className="block"
                                title={`BLK ${(block.score ?? 0).toFixed(2)}`}
                                style={{
                                    left: `${(block.x / size.width) * 100}%`,
                                    top: `${(block.y / size.height) * 100}%`,
                                    width: `${(block.width / size.width) * 100}%`,
                                    height: `${(block.height / size.height) * 100}%`,
                                }}
                            />
                        ))}
                        {size.width > 0
                            ? blockReadings.flatMap((reading, readingIndex) => (
                                (reading.boxes ?? []).map((box, boxIndex) => (
                                    <span
                                        key={`det-${readingIndex}-${boxIndex}-${box.x}-${box.y}`}
                                        className="det-box"
                                        title="Line box drawn on the reader's crop"
                                        style={{
                                            left: `${(box.x / size.width) * 100}%`,
                                            top: `${(box.y / size.height) * 100}%`,
                                            width: `${(box.width / size.width) * 100}%`,
                                            height: `${(box.height / size.height) * 100}%`,
                                        }}
                                    />
                                ))
                            ))
                            : null}
                        {bubbles.map((bubble) => (
                            <span
                                key={`bubble-${bubble.x}-${bubble.y}`}
                                className="bubble"
                                style={{
                                    left: `${(bubble.x / size.width) * 100}%`,
                                    top: `${(bubble.y / size.height) * 100}%`,
                                    width: `${(bubble.width / size.width) * 100}%`,
                                    height: `${(bubble.height / size.height) * 100}%`,
                                }}
                            />
                        ))}
                        {size.width > 0
                            ? boxes.map((box) => {
                                const angle = box.angle ?? 0;
                                const { width, height } = cropSize(box);
                                const centreX = box.x + box.width / 2;
                                const centreY = box.y + box.height / 2;
                                return (
                                    <span
                                        key={`${box.x}-${box.y}-${box.width}-${box.height}-${angle}`}
                                        className="box"
                                        data-direction={box.direction}
                                        title={`${box.kind === 'sfx' ? '[sfx] ' : ''}${box.text || 'no text'} - ${ocrScore(box.confidence)}`}
                                        style={{
                                            left: `${((centreX - width / 2) / size.width) * 100}%`,
                                            top: `${((centreY - height / 2) / size.height) * 100}%`,
                                            width: `${(width / size.width) * 100}%`,
                                            height: `${(height / size.height) * 100}%`,
                                            transform: angle === 0 ? undefined : `rotate(${angle}rad)`,
                                            transformOrigin: 'center',
                                        }}
                                    />
                                );
                            })
                            : null}
                    </div> : (
                        <p className="text-sm text-slate-500">This page has no image URL the debug view can load.</p>
                    )}
                </section>
            ) : null}

            {groups.length > 0 ? (
                <section className={`rounded-md border border-[#e7dfd4] bg-white p-3 shadow-sm ${view === 'debug' ? '' : 'hidden'}`}>
                    <h2 className="text-sm font-semibold">Reading groups</h2>
                    <ol className="mt-2 space-y-2">
                        {groups.map((group) => (
                            <li key={`${group.x}-${group.y}`} className="rounded-md border border-[#e7dfd4] bg-[#f2ede7] p-3">
                                <p className="text-sm font-medium text-slate-800">{group.lines.join('') || 'no text'}</p>
                            </li>
                        ))}
                    </ol>
                </section>
            ) : null}

            {view === 'debug' && blocks.length === 0 ? (
                <section className="rounded-md border border-[#e7dfd4] bg-white p-3 shadow-sm">
                    <h2 className="text-sm font-semibold">No blocks on this page</h2>
                    <p className="mt-1 text-xs text-slate-500">
                        {status || 'Run Detect boxes on this page to see its blocks.'}
                    </p>
                </section>
            ) : null}

            {blocks.length > 0 ? (
                <section className={`rounded-md border border-[#e7dfd4] bg-white p-3 shadow-sm ${view === 'debug' ? '' : 'hidden'}`}>
                    <h2 className="text-sm font-semibold">Blocks ({blocks.length})</h2>
                    <p className="mt-1 text-xs text-slate-500">
                        One card per blk box: the image DeepSeek was sent, which is the blk box with its
                        margin, upscaled and covered by the cell grid, then the regions it answered with.
                        The crop line is the rectangle that was cut, in page pixels, and the grid cell size
                        the reader's numbers are counted in.
                    </p>
                    <ol className="mt-2 flex flex-col gap-3">
                        {blocks.map((block, index) => {
                            const reading = blockReadings[index];
                            // The sent crop when the page is live, and the same
                            // crop cut here after a restore.
                            const thumb = reading?.cropUrl ?? blockThumbs[index];
                            return (
                                <li key={`block-${index}`} className="rounded border border-[#e7dfd4] p-2">
                                    {thumb ? (
                                        <img
                                            src={thumb}
                                            alt=""
                                            title="What the reader was sent: the blk crop with its cell grid"
                                            className="mb-1 max-h-40 rounded border border-[#e7dfd4]"
                                        />
                                    ) : (
                                        <div className="mb-1 flex h-16 w-24 items-center justify-center rounded border border-dashed border-[#ded2c4] text-[11px] text-slate-400">
                                            no crop
                                        </div>
                                    )}
                                    <p className="text-xs font-medium text-slate-700">
                                        BLK {index + 1}: {Math.round(block.x)},{Math.round(block.y)}{' '}
                                        {Math.round(block.width)}×{Math.round(block.height)}
                                    </p>
                                    {blockCrops[index] ? (
                                        <p className="text-[11px] text-slate-500">
                                            crop {Math.round(blockCrops[index].x)},{Math.round(blockCrops[index].y)}{' '}
                                            {Math.round(blockCrops[index].width)}×{Math.round(blockCrops[index].height)}{' '}
                                            · {blockCrops[index].cell.toFixed(1)} px/cell
                                            · {(reading?.boxes ?? []).length === 0
                                                ? 'no boxes drawn, blk + 10 px margin'
                                                : `${(reading?.boxes ?? []).length} box(es) drawn`}
                                        </p>
                                    ) : null}
                                    {reading ? (
                                        <>
                                            {reading.translation ? (
                                                <p className="mt-1 text-[11px] font-medium text-[#7a5c43]">
                                                    {reading.translation}
                                                </p>
                                            ) : null}
                                            <ul className="mt-1 space-y-0.5">
                                                {reading.regions.map((region, regionIndex) => (
                                                    <li key={regionIndex} className="text-[11px] leading-4 text-slate-600">
                                                        {regionIndex + 1}. {region.text} · {Math.round(region.x)},{Math.round(region.y)}{' '}
                                                        {Math.round(region.width)}×{Math.round(region.height)} · {region.direction} · {region.kind}
                                                    </li>
                                                ))}
                                            </ul>
                                            <pre className="mt-1 max-h-48 overflow-auto rounded bg-[#f6f3ef] p-2 text-[11px] leading-4 text-slate-700">
                                                {prettyJson(reading.raw)}
                                            </pre>
                                        </>
                                    ) : (
                                        <p className="mt-1 text-[11px] text-slate-500">No reader answer for this block.</p>
                                    )}
                                </li>
                            );
                        })}
                    </ol>
                </section>
            ) : null}
        </main>
    );
}
