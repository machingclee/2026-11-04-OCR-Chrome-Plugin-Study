import { useCallback, useEffect, useRef, useState } from 'react';
import {
    CONTENT_SCRIPT_FILE,
    DEEPSEEK_KEY,
    DETECTION_CACHE_VERSION,
    OCR_MIN_CONFIDENCE,
    GEMINI_KEY,
    TRANSLATOR_KEY,
    type TranslatorChoice,
    LAST_RESULT_KEY,
    BATCH_STATE_KEY,
    PICKED_IMAGE_TARGET_KEY,
    PICKED_IMAGE_URL_KEY,
} from './shared/constants';
import type {
    BoxData,
    DetectResponse,
    DetectTimings,
    TranslateResponse,
} from './shared/types';
import type { RegionAnswer } from './lib/translatePrompt';
import serviceWorkerRequestFactory from './shared/factories/serviceWorkerRequestFactory';
import { cropSize } from './lib/warp';

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
    visionCrop?: string;
};
function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)} s`;
}

function formatShortcut(value: string): string {
    return value
        .replace(/\bCommand\b/g, '⌘')
        .replace(/\bCtrl\b/g, '⌃')
        .replace(/\bAlt\b/g, '⌥')
        .replace(/\bShift\b/g, '⇧')
        .replace(/\+/g, '');
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
    groups?: GroupStroke[];
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
    const [groups, setGroups] = useState<GroupStroke[]>([]);
    const [translated, setTranslated] = useState<RegionAnswer[] | null>(null);
    const [translating, setTranslating] = useState(false);
    const [deepSeekKey, setDeepSeekKey] = useState('');
    const [geminiKey, setGeminiKey] = useState('');
    const [translator, setTranslator] = useState<TranslatorChoice>('gemini');
    const [dirty, setDirty] = useState(false);
    const [view, setView] = useState<'production' | 'debug'>('production');
    const [activeShortcut, setActiveShortcut] = useState('Alt+T');

    useEffect(() => {
        document.body.style.width = view === 'debug' ? '720px' : '480px';
        document.body.style.maxHeight = view === 'debug' ? '600px' : 'none';
        document.body.style.overflowY = view === 'debug' ? 'auto' : 'visible';
    }, [view]);
    const [targetToken, setTargetToken] = useState<string | undefined>();
    const settingsLoaded = useRef(false);

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
    BATCH_STATE_KEY,
            ]),
        ])
            .then(([local]) => {
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
                settingsLoaded.current = true;
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
                    setGroups(Array.isArray(lastResult.groups) ? lastResult.groups : []);
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
    }, []);

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
                        __comicTranslatorPicker?: { start: () => void };
                    }).__comicTranslatorPicker;
                    if (!picker) return false;
                    picker.start();
                    return true;
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
        setPreviews([]);
        setStatus('Asking the background worker.');

        try {
            const tabPageUrl = await getCurrentPageUrl();
            const response = await sendDetectionRequestToServiceWorker(tabPageUrl, imageUrl);

            if (!response) throw new Error('The background worker sent no answer.');
            if (!response.ok) throw new Error(response.error);

            setBoxes(response.boxes);
            setPreviews(response.previews);
            setBubbles(response.bubbles ?? []);
            setGroups(response.groups ?? []);
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
            if (response.active !== translator) setTranslator(response.active);

            // The background detection writes the same cache the popup reads on
            // reopen. Refresh the inspection lists without forcing a second pass.
            const local = await chrome.storage.local.get(LAST_RESULT_KEY);
            const last = local[LAST_RESULT_KEY] as LastResult | undefined;
            if (last) {
                setBoxes(last.boxes);
                setPreviews(last.previews ?? []);
                setBubbles(last.bubbles ?? []);
                setGroups(last.groups ?? []);
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
        deepSeekKey,
        geminiKey,
        imageUrl,
        targetToken,
        translator,
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
                PICKED_IMAGE_URL_KEY,
                PICKED_IMAGE_TARGET_KEY,
                BATCH_STATE_KEY,
            ]);
            setImageUrl(null);
            setBoxes([]);
            setPreviews([]);
            setBubbles([]);
            setGroups([]);
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

    return (
        <main className={`mx-auto flex flex-col gap-3 rounded-md bg-[#f4f1ec] p-3 text-slate-900 transition-[width] duration-200 ease-out ${view === 'debug' ? 'w-[720px]' : 'w-[480px]'}`}>
            <div className="flex self-start rounded-md bg-[#e9e3da] p-1">
                <button
                    type="button"
                    onClick={() => setView('production')}
                    className={`rounded px-3 py-1.5 text-xs font-medium transition ${view === 'production' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                >
                    Production
                </button>
                <button
                    type="button"
                    onClick={() => setView('debug')}
                    className={`rounded px-3 py-1.5 text-xs font-medium transition ${view === 'debug' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                >
                    Debug
                </button>
            </div>

            <header className="rounded-md border border-[#e7dfd4] bg-white p-3 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h1 className="text-lg font-semibold tracking-tight">Comic Translator</h1>
                        <p className="mt-1 text-sm leading-5 text-slate-600">{status}</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="rounded bg-[#ece4d9] px-2.5 py-1 text-xs font-medium text-[#7a5c43]">v1.0.5</span>
                        <button
                            type="button"
                            onClick={handleResetAll}
                            className="rounded border border-[#ded2c4] bg-white px-2.5 py-1 text-xs font-medium text-[#7a5c43] transition hover:bg-[#f3eee8]"
                        >
                            Clear results
                        </button>
                    </div>
                </div>

                {view === 'debug' ? (
                    <div className="mt-4 grid grid-cols-4 gap-2">
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
                        <kbd className="rounded border border-[#ded2c4] bg-white px-1.5 py-0.5 font-mono text-xs text-[#6d523b]">{formatShortcut(activeShortcut)}</kbd>{' '}
to pick an image, then click the check mark. Change the binding in chrome://extensions/shortcuts.
                    </div>
                )}
            </header>

            {error ? (
                <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                    {error}
                </div>
            ) : null}

            <section className="rounded-md border border-[#e7dfd4] bg-white p-3 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold">Translation settings</h2>
                    <button
                        type="button"
                        onClick={handleSaveSettings}
                        disabled={!dirty}
                        className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition ${dirty ? 'bg-amber-50 text-amber-700 hover:bg-amber-100' : 'bg-emerald-50 text-emerald-700'}`}
                    >
                        <span className={`h-1.5 w-1.5 rounded-full ${dirty ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                        {dirty ? 'Save' : 'Saved'}
                    </button>
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2">
                    <label className="col-span-2 flex flex-col gap-1 text-xs font-medium text-slate-600">
                        Translator
                        <select
                            value={translator}
                            onChange={(event) => {
                                setTranslator(event.target.value as TranslatorChoice);
                                setDirty(true);
                            }}
                            className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-[#b08a68] focus:ring-2 focus:ring-[#eadfd2]"
                        >
                            <option value="gemini">Gemini (free tier)</option>
                            <option value="deepseek">DeepSeek</option>
                            <option value="builtin">This browser</option>
                        </select>
                    </label>

                    <label className={`col-span-2 flex flex-col gap-1 text-xs font-medium text-slate-600 ${translator === 'gemini' ? '' : 'hidden'}`}>
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

                    <label className={`col-span-2 flex flex-col gap-1 text-xs font-medium text-slate-600 ${translator === 'deepseek' ? '' : 'hidden'}`}>
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
            </section>

            {imageUrl ? (
                <section className={`rounded-md border border-[#e7dfd4] bg-white p-3 shadow-sm ${view === 'debug' ? '' : 'hidden'}`}>
                    <div className="mb-2 flex items-center justify-between">
                        <h2 className="text-sm font-semibold">Page preview</h2>
                        <span className="text-xs text-slate-500">{boxes.length} boxes</span>
                    </div>
                    <div className="stage" key={boxes?.length || 0}>
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
                    </div>
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
