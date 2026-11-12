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
    const [targetToken, setTargetToken] = useState<string | undefined>();
    const settingsLoaded = useRef(false);
    const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
    const saveVersion = useRef(0);

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

    // Persist every setting as it changes. The old flow only wrote the API keys
    // when Save settings ran, so typing a key and closing the popup lost it.
    useEffect(() => {
        if (!settingsLoaded.current) return;
        const version = saveVersion.current + 1;
        saveVersion.current = version;
        const payload = {
            [GEMINI_KEY]: geminiKey.trim(),
            [DEEPSEEK_KEY]: deepSeekKey.trim(),
            [TRANSLATOR_KEY]: translator,
        };
        saveQueue.current = saveQueue.current
            .catch(() => undefined)
            .then(() => chrome.storage.local.set(payload))
            .then(() => {
                if (version === saveVersion.current) setDirty(false);
            })
            .catch((cause: unknown) => {
                setError(`Could not save settings: ${cause instanceof Error ? cause.message : String(cause)}`);
                setDirty(true);
            });
    }, [deepSeekKey, geminiKey, translator]);

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

    return (
        <main>
            <h1>Comic Translator</h1>
            <p>{status}</p>


            <div className="actions">
                <button type="button" onClick={handlePick}>
                    Pick an image on this page
                </button>
                <button
                    type="button"
                    onClick={handleDetect}
                    disabled={!imageUrl || busy}
                    data-busy={busy}
                    title={imageUrl ? undefined : 'Pick an image on the page first.'}
                >
                    {busy ? 'Working' : 'Detect boxes'}
                </button>
                <button
                    type="button"
                    onClick={handleTranslate}
                    disabled={translating || !imageUrl}
                    title="Translation runs in the background worker."
                >
                    {translating ? 'Translating' : 'Translate the page'}
                </button>
                <button type="button" onClick={handleClearOverlay} disabled={!imageUrl}>
                    Clear overlay
                </button>

            </div>

            <div className="keys">
                <label>
                    Translator
                    <select
                        value={translator}
                        onChange={(event) => {
                            const choice = event.target.value as TranslatorChoice;
                            setTranslator(choice);
                            setDirty(true);
                            // Persist immediately: forgetting this was why an old
                            // Gemini choice silently came back after reopening.
                            void chrome.storage.local.set({ [TRANSLATOR_KEY]: choice });
                        }}
                    >
                        <option value="gemini">Gemini (free tier)</option>
                        <option value="deepseek">DeepSeek</option>
                        <option value="builtin">This browser</option>
                    </select>
                </label>

                <label>
                    Gemini API key
                    <input
                        type="password"
                        value={geminiKey}
                        placeholder="AIza..."
                        onChange={(event) => {
                            setGeminiKey(event.target.value);
                            setDirty(true);
                        }}
                    />
                    <span className="hint">
                        Used for the vision SFX check when Gemini is the selected translator; DeepSeek uses its own vision model.
                    </span>
                </label>

                <label>
                    DeepSeek API key
                    <input
                        type="password"
                        value={deepSeekKey}
                        placeholder="sk-..."
                        onChange={(event) => {
                            setDeepSeekKey(event.target.value);
                            setDirty(true);
                        }}
                    />
                </label>

                <span />
                <button type="button" className="save" onClick={handleSaveSettings} disabled={!dirty}>
                    {dirty ? 'Save settings' : 'Saved'}
                </button>
            </div>

            {error ? <p role="alert">{error}</p> : null}

            {imageUrl ? (
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
                            // A vertical column keeps its long side vertical, so the
                            // crop size, not the raw line length, decides the box.
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
            ) : null}

            {groups.length > 0 ? (
                <section className="groups">
                    <h2>Reading groups</h2>
                    <ol>
                        {groups.map((group, index) => (
                            <li key={`${group.x}-${group.y}`}>
                                <p className="source">{group.lines.join('') || 'no text'}</p>
                                {translated ? (
                                    <p className="target">
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
                <section className="regions">
                    <h2>Text regions</h2>
                    <ol>
                        {boxes.map((box, index) => (
                            <li key={index}>
                                {previews[index] ? <img src={previews[index]} alt={`Text region ${index + 1}`} /> : null}
                                <p>{box.text || 'no text'}</p>
                                <span className="ocr-score">{ocrScore(box.confidence)}</span>
                            </li>
                        ))}
                    </ol>
                </section>
            ) : null}
        </main>
    );
}
