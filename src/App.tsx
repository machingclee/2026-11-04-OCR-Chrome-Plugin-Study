import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
    CONTENT_SCRIPT_FILE,
    DEEPSEEK_KEY,
    DETECTION_CACHE_VERSION,
    OCR_MIN_CONFIDENCE,
    GEMINI_KEY,
    TRANSLATOR_KEY,
    POPUP_VIEW_KEY,
    type TranslatorChoice,
    type PopupView,
    LAST_RESULT_KEY,
    DEBUG_PAGES_KEY,
    BATCH_STATE_KEY,
    PICKED_IMAGE_TARGET_KEY,
    PICKED_IMAGE_URL_KEY,
    SHOW_TRANSLATION_KEY,
} from './shared/constants';
import type {
    BatchStatusResponse,
    BlockData,
    BoxData,
    DebugPage,
    DetectResponse,
    DetectTimings,
    TranslateResponse,
} from './shared/types';
import type { RegionAnswer } from './lib/translatePrompt';
import serviceWorkerRequestFactory from './shared/factories/serviceWorkerRequestFactory';
import { cropSize } from './lib/warp';

const TRANSLATOR_CHOICES: {
    value: TranslatorChoice;
    name: string;
    description: string;
    icon: ReactNode;
}[] = [
    {
        value: 'gemini',
        name: 'Gemini',
        description: '2.5 Flash, Free-tier',
        icon: (
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
                <path d="M12 2.2 13.7 8.6 20.2 10.2 13.7 11.8 12 18.2 10.3 11.8 3.8 10.2 10.3 8.6 12 2.2Z" />
                <path d="M18.2 14.6 18.9 16.8 21.1 17.5 18.9 18.2 18.2 20.4 17.5 18.2 15.3 17.5 17.5 16.8 18.2 14.6Z" />
            </svg>
        ),
    },
    {
        value: 'deepseek',
        name: 'DeepSeek',
        description: 'Flash model',
        icon: (
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
                <path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45" />
            </svg>
        ),
    },
    {
        value: 'builtin',
        name: 'Browser',
        description: 'Device default',
        icon: (
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
                <path d="M3.5 8.5h17" />
                <path d="M7 6.5h.01M10 6.5h.01" strokeLinecap="round" />
            </svg>
        ),
    },
];

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
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'OCR n/a';
    return `OCR ${(value * 100).toFixed(1)}%`;
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
    blocks?: BlockData[];
    groups?: GroupStroke[];
    detUrl?: string | null;
    segUrl?: string | null;
    ms: number;
    warm?: boolean;
    timings?: DetectTimings;
};

export default function App() {
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [boxes, setBoxes] = useState<BoxData[]>([]);
    const [previews, setPreviews] = useState<string[]>([]);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [status, setStatus] = useState('No image picked yet.');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [bubbles, setBubbles] = useState<BubbleStroke[]>([]);
    const [blocks, setBlocks] = useState<BlockData[]>([]);
    const [groups, setGroups] = useState<GroupStroke[]>([]);
    const [translated, setTranslated] = useState<RegionAnswer[] | null>(null);
    const [translating, setTranslating] = useState(false);
    const [deepSeekKey, setDeepSeekKey] = useState('');
    const [geminiKey, setGeminiKey] = useState('');
    const [translator, setTranslator] = useState<TranslatorChoice>('gemini');
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
                func: (opacity: number) => {
                    (globalThis as unknown as {
                        __comicTranslatorOverlay?: { setOpacity: (value: number) => number };
                    }).__comicTranslatorOverlay?.setOpacity(opacity);
                },
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
    const [targetToken, setTargetToken] = useState<string | undefined>();
    const settingsLoaded = useRef(false);

    const showDebugPage = useCallback((pages: DebugPage[], index: number) => {
        const page = pages[index];
        if (!page) return;
        debugIndexRef.current = index;
        setDebugIndex(index);
        const loadable = page.imageUrl.startsWith('http') || page.imageUrl.startsWith('data:');
        setImageUrl(loadable ? page.imageUrl : null);
        setBoxes(page.boxes);
        setPreviews([]);
        setBubbles(page.bubbles ?? []);
        setBlocks(page.blocks ?? []);
        setGroups(page.groups ?? []);
        setDetUrl(page.detUrl ?? null);
        setSegUrl(page.segUrl ?? null);
        setTranslated(null);
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
                GEMINI_KEY,
                TRANSLATOR_KEY,
                LAST_RESULT_KEY,
                DEBUG_PAGES_KEY,
                SHOW_TRANSLATION_KEY,
            ]),
            chrome.storage.session.get([POPUP_VIEW_KEY]),
        ])
            .then(([local, session]) => {
                const pickedImageUrl = local[PICKED_IMAGE_URL_KEY];
                const storedTarget = local[PICKED_IMAGE_TARGET_KEY];
                if (typeof storedTarget === 'string') setTargetToken(storedTarget);
                const storedDeepSeek = local[DEEPSEEK_KEY];
                if (typeof storedDeepSeek === 'string') setDeepSeekKey(storedDeepSeek);
                const storedGemini = local[GEMINI_KEY];
                if (typeof storedGemini === 'string') setGeminiKey(storedGemini);
                // Remember the translator. If there is no saved choice yet, prefer
                // DeepSeek when its key exists; otherwise Gemini.
                const storedChoice = local[TRANSLATOR_KEY];
                let choice: TranslatorChoice;
                if (storedChoice === 'gemini' || storedChoice === 'deepseek' || storedChoice === 'builtin') {
                    choice = storedChoice;
                } else if (typeof storedDeepSeek === 'string' && storedDeepSeek.trim().length > 0) {
                    choice = 'deepseek';
                } else {
                    choice = 'gemini';
                }
                setTranslator(choice);
                if (storedChoice !== choice) {
                    void chrome.storage.local.set({ [TRANSLATOR_KEY]: choice });
                }
                const storedView = session[POPUP_VIEW_KEY];
                if (storedView === 'production' || storedView === 'debug') {
                    setView(storedView);
                }
                const storedVisible = local[SHOW_TRANSLATION_KEY];
                const visible = storedVisible !== false;
                setTranslationVisible(visible);
                if (!visible) void applyOverlayOpacity(false);
                settingsLoaded.current = true;
                const storedPages = local[DEBUG_PAGES_KEY];
                if (Array.isArray(storedPages) && storedPages.length > 1) {
                    const pages = storedPages as DebugPage[];
                    setDebugPages(pages);
                    showDebugPage(pages, 0);
                    return;
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
                    setPreviews(Array.isArray(lastResult.previews) ? lastResult.previews : []);
                    setBubbles(Array.isArray(lastResult.bubbles) ? lastResult.bubbles : []);
                    setBlocks(Array.isArray(lastResult.blocks) ? lastResult.blocks : []);
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
            if (areaName !== 'local' || !changes[DEBUG_PAGES_KEY]) return;
            const next = changes[DEBUG_PAGES_KEY].newValue;
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
        setBlocks([]);
        setPreviews([]);
        setDetUrl(null);
        setSegUrl(null);
        setStatus('Asking the background worker.');

        try {
            const tabPageUrl = await getCurrentPageUrl();
            const response = await sendDetectionRequestToServiceWorker(tabPageUrl, imageUrl);

            if (!response) throw new Error('The background worker sent no answer.');
            if (!response.ok) throw new Error(response.error);

            setBoxes(response.boxes);
            setPreviews(response.previews);
            setBubbles(response.bubbles ?? []);
            setBlocks(response.blocks ?? []);
            setGroups(response.groups ?? []);
            setDetUrl(response.detUrl);
            setSegUrl(response.segUrl);
            setTranslated(null);
            const vertical = response.boxes.filter((box) => box.direction === 'vertical').length;
            const ruby = response.boxes.reduce((sum, box) => sum + box.ruby.length, 0);
            const read = response.boxes.filter((box) => box.text.length > 0).length;
            const lowConfidence = response.boxes.filter((box) =>
                box.text.length > 0 && box.confidence < OCR_MIN_CONFIDENCE,
            ).length;
            setStatus(
                `${response.boxes.length} lines (${vertical} vertical, ${ruby} ruby), ${read} read (${lowConfidence} below OCR floor), ${response.bubbles?.length ?? 0} balloons, ${response.groupedLines} grouped, image ${response.imageWidth}x${response.imageHeight}, ${seconds(response.ms)} (${response.warm ? 'reused session' : 'cold session'}${stageSummary(response.timings)}).`,
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

            // handled in src/background/index.ts
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

    const handleTranslate = useCallback(async () => {
        setTranslating(true);
        setError('');
        try {
            if (!imageUrl) throw new Error('No image was picked.');
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) throw new Error('There is no active tab.');
            const tabPageUrl = tab.url?.startsWith('http') ? tab.url : undefined;
            const response = (await chrome.runtime.sendMessage(
                serviceWorkerRequestFactory.ofTranslation({
                    imageUrl,
                    tabPageUrl,
                    tabId: tab.id,
                    token: targetToken,
                    settings: {
                        translator,
                        deepSeekKey,
                        geminiKey,
                        font: 'sans',
                        leading: 1,
                        weight: 'normal',
                    },
                }),
            )) as TranslateResponse | undefined;
            if (!response) throw new Error('The background worker sent no answer.');
            if (!response.ok) throw new Error(response.error);

            setTranslated(response.answers);
            if (!translationVisible) await applyOverlayOpacity(false);
            if (response.active !== translator) setTranslator(response.active);

            // The background detection writes the same cache the popup reads on
            // reopen. Refresh the inspection lists without forcing a second pass.
            const local = await chrome.storage.local.get(LAST_RESULT_KEY);
            const last = local[LAST_RESULT_KEY] as LastResult | undefined;
            if (last) {
                setBoxes(last.boxes);
                setPreviews(last.previews ?? []);
                setBubbles(last.bubbles ?? []);
                setBlocks(last.blocks ?? []);
                setGroups(last.groups ?? []);
                setDetUrl(last.detUrl ?? null);
                setSegUrl(last.segUrl ?? null);
            }

            const session = response.warm ? 'warm session; ' : 'cold session; ';
            const detectionStatus = `; detection ${seconds(response.ms)}${response.timings ? ` (${session}${stageBreakdown(response.timings)})` : ''}`;
            setStatus(
                `Overlaid ${response.count} translated boxes with ${response.used} on the page (${response.balloons} balloons, ${response.withBalloon} groups inside one)${detectionStatus}${response.skipped ? `; left ${response.skipped} UI/name/SFX regions untouched` : ''}.`,
            );
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setTranslating(false);
        }
    }, [
        applyOverlayOpacity,
        deepSeekKey,
        geminiKey,
        imageUrl,
        targetToken,
        translator,
        translationVisible,
    ]);

    const handleClearOverlay = useCallback(async () => {
        setError(null);
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) throw new Error('There is no active tab.');
            await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                files: [CONTENT_SCRIPT_FILE],
            });
            await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                world: 'ISOLATED',
                func: () => {
                    try {
                        (globalThis as unknown as {
                            __comicTranslatorOverlay?: { clear: () => void };
                        }).__comicTranslatorOverlay?.clear();
                    } catch {
                        // The page may have removed the wrapper already.
                    }
                },
            });
            setStatus('Cleared the translated overlay.');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }, []);

    const handleResetAll = useCallback(async () => {
        setError(null);
        await handleClearOverlay();
        try {
            await chrome.storage.local.remove([
                LAST_RESULT_KEY,
                DEBUG_PAGES_KEY,
                PICKED_IMAGE_URL_KEY,
                PICKED_IMAGE_TARGET_KEY,
                BATCH_STATE_KEY,
            ]);
            setDebugPages([]);
            setDebugIndex(0);
            debugIndexRef.current = 0;
            setImageUrl(null);
            setBoxes([]);
            setPreviews([]);
            setBubbles([]);
            setGroups([]);
            setDetUrl(null);
            setSegUrl(null);
            setTranslated(null);
            setTargetToken(undefined);
            setSize({ width: 0, height: 0 });
            setStatus('Cleared all saved results.');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }, [handleClearOverlay]);

    useEffect(() => {
        void chrome.commands.getAll().then((commands) => {
            const command = commands.find((entry) => entry.name === 'pick-image');
            if (command?.shortcut) setActiveShortcut(command.shortcut);
        }).catch(() => undefined);
    }, []);

    const handleSaveSettings = useCallback(async () => {
        try {
            await chrome.storage.local.set({
                [GEMINI_KEY]: geminiKey.trim(),
                [DEEPSEEK_KEY]: deepSeekKey.trim(),
                [TRANSLATOR_KEY]: translator,
            });
            setDirty(false);
            setStatus('Settings saved.');
        } catch (cause) {
            setError(`Could not save settings: ${cause instanceof Error ? cause.message : String(cause)}`);
            setDirty(true);
        }
    }, [deepSeekKey, geminiKey, translator]);

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

            context.save();
            context.strokeStyle = '#1f9d55';
            context.lineWidth = scale;
            for (const block of blocks) {
                context.strokeRect(block.x, block.y, block.width, block.height);
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
            setStatus(`Saved the page with det, seg and ${boxes.length} boxes drawn on it as ${name}.`);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }, [blocks, bubbles, boxes, detUrl, imageUrl, segUrl, size.height, size.width]);

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
                    <span className="shrink-0 rounded bg-[#ece4d9] px-2.5 py-1 text-xs font-medium text-[#7a5c43]">v1.0.5</span>
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

                    <div className="mt-2">
                        <p className="text-xs font-medium text-slate-600">Translator</p>
                        <div className="mt-2 ml-2 border-l-2 border-[#e9e0d3] pl-3">
                            <div className="flex flex-col gap-2" role="radiogroup" aria-label="Translator">
                                {TRANSLATOR_CHOICES.map((choice) => {
                                    const selected = translator === choice.value;
                                    return (
                                        <label
                                            key={choice.value}
                                            className={`flex cursor-pointer items-center gap-2 rounded border px-2.5 py-1.5 transition focus-within:ring-2 focus-within:ring-[#eadfd2] ${selected ? 'border-[#b3815c] bg-[#f3eee8] text-[#5f4a38]' : 'border-[#ded2c4] bg-white text-slate-700 hover:bg-[#fbf8f4]'}`}
                                        >
                                            <input
                                                type="radio"
                                                name="translator"
                                                value={choice.value}
                                                checked={selected}
                                                onChange={() => {
                                                    setTranslator(choice.value);
                                                    setDirty(true);
                                                }}
                                                className="accent-[#b3815c]"
                                            />
                                            <span className={`shrink-0 ${selected ? 'text-[#b3815c]' : 'text-[#8a6a4f]'}`}>{choice.icon}</span>
                                            <span className="shrink-0 text-xs font-semibold">{choice.name}</span>
                                            <span className={`truncate text-[11px] font-medium ${selected ? 'text-[#7a5c43]' : 'text-slate-500'}`}>{choice.description}</span>
                                        </label>
                                    );
                                })}
                            </div>
                        </div>

                        {/* The API key field sits at the same level as the
                            "Translator" label, outside the option indent. */}
                        {translator !== 'builtin' ? (
                            <div className="mt-3 flex flex-col gap-2">
                                <label className={`flex flex-col gap-1 text-xs font-medium text-slate-600 ${translator === 'gemini' ? '' : 'hidden'}`}>
                                    Gemini API key
                                    <input
                                        type="password"
                                        value={geminiKey}
                                        placeholder="AIza..."
                                        onChange={(event) => {
                                            setGeminiKey(event.target.value);
                                            setDirty(true);
                                        }}
                                        className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#b08a68] focus:ring-2 focus:ring-[#eadfd2]"
                                    />
                                </label>

                                <label className={`flex flex-col gap-1 text-xs font-medium text-slate-600 ${translator === 'deepseek' ? '' : 'hidden'}`}>
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
                            </div>
                        ) : null}
                    </div>
                </section>
                ) : null}

                {view === 'debug' ? (
                    <div className="mt-3 grid grid-cols-4 gap-2">
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
                        <button
                            type="button"
                            onClick={handleTranslate}
                            disabled={translating || !imageUrl}
                            title="Translation runs in the background worker."
                            className="rounded bg-[#b3815c] px-3 py-2 text-sm font-medium text-white transition hover:bg-[#a5724f] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {translating ? 'Translating...' : 'Detect + Translate'}
                        </button>
                        <button
                            type="button"
                            onClick={handleClearOverlay}
                            disabled={!imageUrl}
                            className="rounded bg-[#b3815c] px-3 py-2 text-sm font-medium text-white transition hover:bg-[#a5724f] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            Clear overlay
                        </button>
                    </div>
                ) : (
                    <div className="mt-3 rounded-md border border-[#ded2c4] bg-[#f3eee8] px-3 py-2 text-sm text-[#5f4a38]">
                        Press{' '}
                        <kbd className="rounded border border-[#ded2c4] bg-white px-1.5 py-0.5 font-mono text-xs text-[#6d523b]">{macShortcut}</kbd>
                        {' '}on Mac, or{' '}
                        <kbd className="rounded border border-[#ded2c4] bg-white px-1.5 py-0.5 font-mono text-xs text-[#6d523b]">{windowsShortcut}</kbd>
                        {' '}on Windows, then drag to select images.
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
                            <span className="whitespace-nowrap text-xs text-slate-500">{boxes.length} boxes</span>
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
                                title="Download this page with the det map, the seg map and every box drawn on it (JPEG)."
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
                                        title={`${box.text || 'no text'} - ${ocrScore(box.confidence)}`}
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
                        {size.width > 0 ? blocks.map((block) => (
                            <span
                                key={`block-${block.x}-${block.y}-${block.width}`}
                                className="block"
                                title={`blk ${block.score.toFixed(2)}`}
                                style={{
                                    left: `${(block.x / size.width) * 100}%`,
                                    top: `${(block.y / size.height) * 100}%`,
                                    width: `${(block.width / size.width) * 100}%`,
                                    height: `${(block.height / size.height) * 100}%`,
                                }}
                            />
                        )) : null}
                    </div> : (
                        <p className="text-sm text-slate-500">This page has no image URL the debug view can load.</p>
                    )}
                </section>
            ) : null}

            {groups.length > 0 ? (
                <section className={`rounded-md border border-[#e7dfd4] bg-white p-3 shadow-sm ${view === 'debug' ? '' : 'hidden'}`}>
                    <h2 className="text-sm font-semibold">Reading groups</h2>
                    <ol className="mt-2 space-y-2">
                        {groups.map((group, index) => (
                            <li key={`${group.x}-${group.y}`} className="rounded-md border border-[#e7dfd4] bg-[#f2ede7] p-3">
                                <p className="text-sm font-medium text-slate-800">{group.lines.join('') || 'no text'}</p>
                                {translated ? (
                                    <p className="mt-1 text-sm text-slate-600">
                                        {translated[index]?.skip
                                            ? '(not translated - UI/name/SFX)'
                                            : translated[index]?.text ?? ''}
                                    </p>
                                ) : null}
                            </li>
                        ))}
                    </ol>
                </section>
            ) : null}

            {previews.length > 0 ? (
                <section className={`rounded-md border border-[#e7dfd4] bg-white p-3 shadow-sm ${view === 'debug' ? '' : 'hidden'}`}>
                    <h2 className="text-sm font-semibold">Text regions</h2>
                    <ol className="mt-2 flex gap-3 overflow-x-auto pb-1">
                        {boxes.map((box, index) => (
                            <li key={index} className="w-40 shrink-0">
                                {previews[index] ? (
                                    <img src={previews[index]} alt={`Text region ${index + 1}`} className="max-h-28 w-full rounded border border-[#e7dfd4] bg-white object-contain" />
                                ) : null}
                                <p className="mt-1 text-xs leading-4 text-slate-600">{box.text || 'no text'}</p>
                                <span className="ocr-score">{ocrScore(box.confidence)}</span>
                            </li>
                        ))}
                    </ol>
                </section>
            ) : null}
        </main>
    );
}
