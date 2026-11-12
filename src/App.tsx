import { useCallback, useEffect, useRef, useState } from 'react';
import {
    CONTENT_SCRIPT_FILE,
    DEEPSEEK_KEY,
    GEMINI_KEY,
    FONT_KEY,
    LEADING_KEY,
    LEADING_MAX,
    LEADING_MIN,
    WEIGHT_KEY,
    type FontChoice,
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
    OverlayItem,
    OverlayRequest,
    OverlayResponse,
} from './shared/types';
import { BUILD_ID } from './shared/build';
import { canTranslate, translateAll } from './lib/translate';
import { translateWithDeepSeek } from './lib/translateDeepSeek';
import { translateWithGemini } from './lib/translateGemini';
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
};
function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)} s`;
}

function stageSummary(timings?: DetectTimings): string {
    if (!timings) return '';
    return `; detect ${seconds(timings.detect)}, OCR ${seconds(timings.ocr)}, bubbles ${seconds(timings.bubble)}`;
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

/**
 * A group that came from a block holds a big box, and painting into it would
 * cover the drawing. The lines themselves decide the area, which keeps a
 * page-sized balloon from turning into a page-sized text column.
 */
function tightenBox(group: GroupStroke, lines: BoxData[]): GroupStroke {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const line of lines) {
        const centreX = line.x + line.width / 2;
        const centreY = line.y + line.height / 2;
        if (centreX < group.x || centreX > group.x + group.width) continue;
        if (centreY < group.y || centreY > group.y + group.height) continue;
        minX = Math.min(minX, line.x);
        minY = Math.min(minY, line.y);
        maxX = Math.max(maxX, line.x + line.width);
        maxY = Math.max(maxY, line.y + line.height);
    }

    if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return group;

    const pad = Math.max(3, Math.min(maxX - minX, maxY - minY) * 0.08);
    return {
        x: minX - pad,
        y: minY - pad,
        width: maxX - minX + pad * 2,
        height: maxY - minY + pad * 2,
        lines: group.lines,
    };
}

/** How many groups found a balloon, which is the number that places them. */
function countWithBalloon(list: GroupStroke[], balloons: BubbleStroke[]): number {
    return list.filter((group) => {
        const centreX = group.x + group.width / 2;
        const centreY = group.y + group.height / 2;
        return balloons.some((bubble) =>
            centreX >= bubble.x && centreX <= bubble.x + bubble.width
            && centreY >= bubble.y && centreY <= bubble.y + bubble.height);
    }).length;
}

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
    const [font, setFont] = useState<FontChoice>('sans');
    const [leading, setLeading] = useState(1.15);
    const [weight, setWeight] = useState<'normal' | 'bold'>('normal');
    const [bubbleError, setBubbleError] = useState<string | null>(null);
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
                FONT_KEY,
                LEADING_KEY,
                WEIGHT_KEY,
            ]),
            chrome.storage.session.get(LAST_RESULT_KEY),
        ])
            .then(([local, session]) => {
                const pickedImageUrl = local[PICKED_IMAGE_URL_KEY];
                const storedTarget = local[PICKED_IMAGE_TARGET_KEY];
                if (typeof storedTarget === 'string') setTargetToken(storedTarget);
                const storedDeepSeek = local[DEEPSEEK_KEY];
                if (typeof storedDeepSeek === 'string') setDeepSeekKey(storedDeepSeek);
                const storedGemini = local[GEMINI_KEY];
                if (typeof storedGemini === 'string') setGeminiKey(storedGemini);
                const storedLeading = local[LEADING_KEY];
                if (typeof storedLeading === 'number') setLeading(storedLeading);
                const storedWeight = local[WEIGHT_KEY];
                if (storedWeight === 'normal' || storedWeight === 'bold') setWeight(storedWeight);
                const storedFont = local[FONT_KEY];
                if (storedFont === 'sans' || storedFont === 'serif') setFont(storedFont);
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
                const lastResult = session[LAST_RESULT_KEY] as LastResult | undefined;

                if (typeof pickedImageUrl !== 'string' || pickedImageUrl.length === 0) {
                    return;
                }

                setImageUrl(pickedImageUrl);

                // don't do it again if we pick the same image
                const fresh = lastResult?.version === BUILD_ID;
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
            [FONT_KEY]: font,
            [LEADING_KEY]: leading,
            [WEIGHT_KEY]: weight,
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
    }, [deepSeekKey, font, geminiKey, leading, translator, weight]);

    const handleSaveSettings = useCallback(async () => {
        try {
            await chrome.storage.local.set({
                [GEMINI_KEY]: geminiKey.trim(),
                [DEEPSEEK_KEY]: deepSeekKey.trim(),
                [TRANSLATOR_KEY]: translator,
                [FONT_KEY]: font,
                [LEADING_KEY]: leading,
                [WEIGHT_KEY]: weight,
            });
            setDirty(false);
            setStatus('Settings saved.');
        } catch (cause) {
            setError(`Could not save settings: ${cause instanceof Error ? cause.message : String(cause)}`);
            setDirty(true);
        }
    }, [deepSeekKey, font, geminiKey, leading, translator, weight]);


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
            setBubbleError(response.bubbleError ?? null);
            const vertical = response.boxes.filter((box) => box.direction === 'vertical').length;
            const ruby = response.boxes.reduce((sum, box) => sum + box.ruby.length, 0);
            const read = response.boxes.filter((box) => box.text.length > 0).length;
            setStatus(
                `${response.boxes.length} lines (${vertical} vertical, ${ruby} ruby), ${read} read, ${response.bubbles?.length ?? 0} balloons, ${response.groupedLines} grouped, image ${response.imageWidth}x${response.imageHeight}, ${seconds(response.ms)} (${response.warm ? 'reused session' : 'cold session'}${stageSummary(response.timings)}).`,
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
            // One press does the whole job: measure the page when it has not been
            // measured yet, translate every group, then place the answer over the
            // live image in the tab.
            let current = groups;
            let currentBoxes = boxes;
            let pageWidth = size.width;
            let pageHeight = size.height;
            // A detection run updates the state asynchronously, so the balloons
            // for this pass must come from the answer, not from the state.
            let balloons = bubbles;
            if (current.length === 0) {
                const detected = await runDetect();
                if (!detected || !detected.ok) throw new Error('The detection pass failed.');
                current = detected.groups ?? [];
                balloons = detected.bubbles ?? [];
                currentBoxes = detected.boxes;
                pageWidth = detected.imageWidth;
                pageHeight = detected.imageHeight;
            }
            if (current.length === 0) throw new Error('No text was found on this page.');
            if (pageWidth <= 0 || pageHeight <= 0) {
                pageWidth = Math.max(...currentBoxes.map((box) => box.x + box.width), 1);
                pageHeight = Math.max(...currentBoxes.map((box) => box.y + box.height), 1);
            }

            const regions = current.map((group, index) => ({
                id: `r${index + 1}`,
                direction: (group.height > group.width * 1.3 ? 'v' : 'h') as 'v' | 'h',
                lines: group.lines,
            }));
            // If the selected provider has no key but the other one does, use the
            // one that can actually run instead of falling back to the browser.
            let active = translator;
            if (active === 'gemini' && geminiKey.trim().length === 0 && deepSeekKey.trim().length > 0) {
                active = 'deepseek';
            } else if (active === 'deepseek' && deepSeekKey.trim().length === 0 && geminiKey.trim().length > 0) {
                active = 'gemini';
            }
            if (active !== translator) {
                setTranslator(active);
                void chrome.storage.local.set({ [TRANSLATOR_KEY]: active });
            }
            const key = active === 'gemini' ? geminiKey.trim() : deepSeekKey.trim();
            let used = active === 'gemini' ? 'Gemini' : active === 'deepseek' ? 'DeepSeek' : 'browser';

            let out: RegionAnswer[] | null = null;
            if (active === 'builtin') {
                used = 'browser';
                const plain = current.map((group) => group.lines.join(''));
                out = canTranslate()
                    ? (await translateAll(plain, 'ja', 'zh-Hant')).map((text) => ({ text }))
                    : null;
            } else if (key.length > 0) {
                out = active === 'gemini'
                    ? await translateWithGemini(regions, key)
                    : await translateWithDeepSeek(regions, key);
            } else if (canTranslate()) {
                used = 'browser (no API key)';
                const plain = current.map((group) => group.lines.join(''));
                out = (await translateAll(plain, 'ja', 'zh-Hant')).map((text) => ({ text }));
                setStatus('No key, so the browser translator did the work.');
            }

            if (!out) {
                throw new Error(
                    translator === 'builtin'
                        ? 'This Chrome ships no translator. Pick Gemini or DeepSeek and paste a key.'
                        : `Paste a ${translator === 'gemini' ? 'Gemini' : 'DeepSeek'} key above.`,
                );
            }

            const items: OverlayItem[] = [];
            let skipped = 0;
            current.forEach((group, index) => {
                const answer = out[index];
                if (answer?.skip) {
                    skipped += 1;
                    return;
                }
                const text = answer?.text ?? group.lines.join('');
                if (text.trim().length === 0) {
                    skipped += 1;
                    return;
                }
                const layout = tightenBox(group, currentBoxes);
                items.push({
                    x: layout.x,
                    y: layout.y,
                    width: layout.width,
                    height: layout.height,
                    text,
                    vertical: layout.height > layout.width * 1.3,
                    background: group.background,
                    color: group.color,
                    maskUrl: group.maskUrl,
                    maskBox: group.maskBox,
                    rectangle: group.rectangle,
                    fontSize: group.fontSize,
                });
            });
            if (items.length === 0) throw new Error('The translation returned no dialogue to place.');
            setTranslated(out);

            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) throw new Error('There is no active tab.');
            await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                files: [CONTENT_SCRIPT_FILE],
            });
            const request: OverlayRequest = {
                token: targetToken,
                imageUrl,
                width: pageWidth,
                height: pageHeight,
                items,
                fontFamily: font === 'serif'
                    ? '"Songti TC", "Noto Serif CJK TC", serif'
                    : 'system-ui, "PingFang TC", sans-serif',
                weight,
                leading,
            };
            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                world: 'ISOLATED',
                args: [request],
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
                        return {
                            ok: false,
                            error: cause instanceof Error ? cause.message : String(cause),
                        };
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
                throw new Error(failure?.error ?? 'The page did not accept the overlay.');
            }

            const withBalloon = countWithBalloon(current, balloons);
            setStatus(
                `Overlaid ${placed.count} translated boxes with ${used} on the page (${balloons.length} balloons, ${withBalloon} groups inside one)${skipped ? `; left ${skipped} UI/name/SFX regions untouched` : ''}${bubbleError ? `; balloon error: ${bubbleError}` : ''}.`,
            );
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setTranslating(false);
        }
    }, [
        boxes,
        bubbles,
        deepSeekKey,
        font,
        geminiKey,
        groups,
        imageUrl,
        leading,
        runDetect,
        size.height,
        size.width,
        targetToken,
        translator,
        weight,
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
                    title={canTranslate() ? undefined : 'This browser ships no translator.'}
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

                <label>
                    Line spacing
                    <input
                        type="range"
                        min={LEADING_MIN}
                        max={LEADING_MAX}
                        step={0.05}
                        value={leading}
                        onChange={(event) => {
                            setLeading(Number(event.target.value));
                            setDirty(true);
                        }}
                    />
                    <span className="hint">{leading.toFixed(2)}</span>
                </label>

                <label>
                    Weight
                    <select
                        value={weight}
                        onChange={(event) => {
                            setWeight(event.target.value as 'normal' | 'bold');
                            setDirty(true);
                        }}
                    >
                        <option value="normal">Normal</option>
                        <option value="bold">Bold</option>
                    </select>
                </label>

                <label>
                    Lettering font
                    <select
                        value={font}
                        onChange={(event) => {
                            setFont(event.target.value as FontChoice);
                            setDirty(true);
                        }}
                    >
                        <option value="sans">Sans (PingFang)</option>
                        <option value="serif">Serif (Songti)</option>
                    </select>
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
                            </li>
                        ))}
                    </ol>
                </section>
            ) : null}
        </main>
    );
}
