import { useCallback, useEffect, useState } from 'react';
import {
    CONTENT_SCRIPT_FILE,
    DEEPSEEK_KEY,
    GEMINI_KEY,
    FONT_KEY,
    LEADING_KEY,
    LEADING_MAX,
    LEADING_MIN,
    WEIGHT_KEY,
    REPLACE_IMAGE_MESSAGE,
    UNDO_IMAGE_MESSAGE,
    type FontChoice,
    TRANSLATOR_KEY,
    type TranslatorChoice,
    LAST_RESULT_KEY,
    PICKED_IMAGE_URL_KEY,
} from './shared/constants';
import type { BoxData, DetectResponse } from './shared/types';
import { BUILD_ID } from './shared/build';
import { canTranslate, translateAll } from './lib/translate';
import { translateWithDeepSeek } from './lib/translateDeepSeek';
import { translateWithGemini } from './lib/translateGemini';
import type { RegionAnswer } from './lib/translatePrompt';
import { renderTypeset } from './lib/typeset';
import serviceWorkerRequestFactory from './shared/factories/serviceWorkerRequestFactory';
import { cropSize } from './lib/warp';

type BubbleStroke = {
    x: number;
    y: number;
    width: number;
    height: number;
    outline?: { x: number; y: number }[];
};
type GroupStroke = { x: number; y: number; width: number; height: number; lines: string[] };
/** Shrink the text until it fits its balloon, one pixel at a time. */
const fitText = (element: HTMLSpanElement): void => {
    const start = Number.parseFloat(element.dataset.max ?? '40');
    let size = start;
    element.style.fontSize = `${size}px`;
    if (element.clientHeight === 0) return;
    while (size > 7 && (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)) {
        size -= 1;
        element.style.fontSize = `${size}px`;
    }
};
type LastResult = {
    version?: string;
    imageUrl: string;
    boxes: BoxData[];
    previews?: string[];
    bubbles?: BubbleStroke[];
    groups?: GroupStroke[];
    erasedUrl?: string | null;
    ms: number;
};

/** Pull a balloon inward, so text sits in its middle instead of on its edge. */
function insetBubble(bubble: BubbleStroke, ratio = 0.14): GroupStroke {
    const dx = bubble.width * ratio;
    const dy = bubble.height * ratio;
    return {
        x: bubble.x + dx,
        y: bubble.y + dy,
        width: Math.max(12, bubble.width - dx * 2),
        height: Math.max(12, bubble.height - dy * 2),
        lines: [],
    };
}

/**
 * A group that came from a block holds a big box, and painting into it would
 * cover the drawing. Without a balloon, the lines themselves decide the area.
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

/**
 * The balloon model returns a loose box and a tight outline. The outline is what
 * the balloon really covers, so the text is measured inside that instead.
 */
function bubbleBox(bubble: BubbleStroke): GroupStroke {
    const points = bubble.outline ?? [];
    if (points.length < 3) return insetBubble(bubble);

    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const dx = (maxX - minX) * 0.07;
    const dy = (maxY - minY) * 0.07;

    return {
        x: minX + dx,
        y: minY + dy,
        width: Math.max(12, maxX - minX - dx * 2),
        height: Math.max(12, maxY - minY - dy * 2),
        lines: [],
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
    const [wrote, setWrote] = useState(false);
    const [erasedUrl, setErasedUrl] = useState<string | null>(null);
    const [bubbleError, setBubbleError] = useState<string | null>(null);
    const [typesetUrl, setTypesetUrl] = useState<string | null>(null);
    const [showDebug, setShowDebug] = useState(false);

    useEffect(() => {
        if (!translated) return;
        const frame = requestAnimationFrame(() => {
            document.querySelectorAll<HTMLSpanElement>('.typeset').forEach(fitText);
        });
        return () => cancelAnimationFrame(frame);
    }, [translated, groups]);
    useEffect(() => {
        // start working when we open this popup again,
        // at this point our newly picked image url is nonempty.
        Promise.all([
            chrome.storage.local.get([PICKED_IMAGE_URL_KEY]),
            chrome.storage.session.get(LAST_RESULT_KEY),
        ])
            .then(([local, session]) => {
                const pickedImageUrl = local[PICKED_IMAGE_URL_KEY];
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
                const storedChoice = local[TRANSLATOR_KEY];
                if (storedChoice === 'gemini' || storedChoice === 'deepseek' || storedChoice === 'builtin') {
                    setTranslator(storedChoice);
                }
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
                    setErasedUrl(typeof lastResult.erasedUrl === 'string' ? lastResult.erasedUrl : null);
                    setStatus(`Restored ${lastResult.boxes.length} boxes from ${lastResult.ms} ms.`);
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
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [CONTENT_SCRIPT_FILE] });
            window.close();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }, []);

    /** Paint the finished page and put it in place of the picked image. */
    const applyToPage = useCallback(async (
        answers: RegionAnswer[],
        list: GroupStroke[],
        balloons: BubbleStroke[],
    ): Promise<void> => {
        const ruby = boxes.flatMap((box) => box.ruby);
        if (!imageUrl) throw new Error('No image was picked.');

        // The page image comes from another origin, so drawing the <img> would
        // taint the canvas. Fetching the bytes gives us a clean source instead.
        const source = erasedUrl ?? imageUrl;
        let response = await fetch(source, { credentials: 'include' });
        if (!response.ok && erasedUrl) {
            response = await fetch(imageUrl, { credentials: 'include' });
        }
        if (!response.ok) throw new Error(`Image fetch failed with ${response.status}.`);
        const bitmap = await createImageBitmap(await response.blob());

        const dataUrl = renderTypeset(
            bitmap,
            bitmap.width,
            bitmap.height,
            list.map((group, index) => {
                const holder = balloons.find((bubble) =>
                    group.x + group.width / 2 >= bubble.x
                    && group.x + group.width / 2 <= bubble.x + bubble.width
                    && group.y + group.height / 2 >= bubble.y
                    && group.y + group.height / 2 <= bubble.y + bubble.height);
                // A column box is not a container. The balloon is, so the text
                // is laid out in its middle and clipped to its edge.
                return {
                    box: holder ? bubbleBox(holder) : tightenBox(group, boxes),
                    text: answers[index]?.text ?? group.lines.join(''),
                    columns: answers[index]?.columns,
                    outline: holder?.outline,
                };
            }),
            ruby,
            {
                family: font === 'serif'
                    ? '"Songti TC", "Noto Serif CJK TC", serif'
                    : 'system-ui, "PingFang TC", sans-serif',
                leading,
                weight,
                minSize: 9,
                maxSize: 26,
            },
        );

        setTypesetUrl(dataUrl);
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error('There is no active tab.');
        await chrome.tabs.sendMessage(tab.id, {
            type: REPLACE_IMAGE_MESSAGE,
            url: imageUrl,
            dataUrl,
        });
        bitmap.close();
    }, [boxes, erasedUrl, font, imageUrl, leading, weight]);

    const handleUndo = useCallback(async () => {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) throw new Error('There is no active tab.');
            await chrome.tabs.sendMessage(tab.id, { type: UNDO_IMAGE_MESSAGE });
            setWrote(false);
            setStatus('Put the original image back.');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }, []);

    const handleSaveSettings = useCallback(async () => {
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
            setErasedUrl(response.erasedUrl ?? null);
            setBubbleError(response.bubbleError ?? null);
            setTranslated(null);
            const vertical = response.boxes.filter((box) => box.direction === 'vertical').length;
            const ruby = response.boxes.reduce((sum, box) => sum + box.ruby.length, 0);
            const read = response.boxes.filter((box) => box.text.length > 0).length;
            setStatus(
                `${response.boxes.length} lines (${vertical} vertical, ${ruby} ruby), ${read} read, ${response.bubbles?.length ?? 0} balloons, ${response.groupedLines} grouped, image ${response.imageWidth}x${response.imageHeight}, ${response.ms} ms (${response.warm ? 'reused session' : 'cold session'}).`,
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
            // One press does the whole job: measure the page when it has not been
            // measured yet, translate every group, then paint the answer back.
            let current = groups;
            // A detection run updates the state asynchronously, so the balloons
            // for this pass must come from the answer, not from the state.
            let balloons = bubbles;
            if (current.length === 0) {
                const detected = await runDetect();
                if (!detected || !detected.ok) throw new Error('The detection pass failed.');
                current = detected.groups ?? [];
                balloons = detected.bubbles ?? [];
            }
            if (current.length === 0) throw new Error('No text was found on this page.');

            const regions = current.map((group, index) => ({
                id: `r${index + 1}`,
                direction: (group.height > group.width * 1.3 ? 'v' : 'h') as 'v' | 'h',
                lines: group.lines,
            }));
            const key = translator === 'gemini' ? geminiKey.trim() : deepSeekKey.trim();

            let out: RegionAnswer[] | null = null;
            if (translator === 'builtin') {
                const plain = current.map((group) => group.lines.join(''));
                out = canTranslate()
                    ? (await translateAll(plain, 'ja', 'zh-Hant')).map((text) => ({ text }))
                    : null;
            } else if (key.length > 0) {
                out = translator === 'gemini'
                    ? await translateWithGemini(regions, key)
                    : await translateWithDeepSeek(regions, key);
            } else if (canTranslate()) {
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

            setTranslated(out);
            await applyToPage(out, current, balloons);
            const withBalloon = countWithBalloon(current, balloons);
            setStatus(
                `Translated ${out.length} groups, ${withBalloon} with a balloon, ${balloons.length} balloons${bubbleError ? `, balloon error: ${bubbleError}` : ''}, wrote them to the page.`,
            );
            setWrote(true);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setTranslating(false);
        }
    }, [applyToPage, bubbles, deepSeekKey, geminiKey, groups, runDetect, translator]);

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
                <button type="button" onClick={handleUndo} disabled={!wrote}>
                    Put the original back
                </button>
                <button type="button" onClick={() => setShowDebug((value) => !value)}>
                    {showDebug ? 'Hide stages' : 'Show stages'}
                </button>

            </div>

            <div className="keys">
                <label>
                    Translator
                    <select
                        value={translator}
                        onChange={(event) => {
                            setTranslator(event.target.value as TranslatorChoice);
                            setDirty(true);
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
                    {translated
                        ? groups.map((group, index) => {
                              const holder = bubbles.find((bubble) =>
                                  group.x + group.width / 2 >= bubble.x
                                  && group.x + group.width / 2 <= bubble.x + bubble.width
                                  && group.y + group.height / 2 >= bubble.y
                                  && group.y + group.height / 2 <= bubble.y + bubble.height);
                              const vertical = group.height > group.width * 1.3;
                              const clip = holder?.outline && holder.outline.length > 2
                                  ? `polygon(${holder.outline
                                        .map((point) => `${((point.x - group.x) / group.width) * 100}% ${((point.y - group.y) / group.height) * 100}%`)
                                        .join(', ')})`
                                  : undefined;
                              return (
                                  <span
                                      key={`group-${group.x}-${group.y}-${(translated[index]?.text ?? '').length}`}
                                      className="typeset"
                                      data-vertical={vertical}
                                      data-max={Math.max(12, Math.round(Math.min(group.width, group.height)))}
                                      style={{
                                          left: `${(group.x / size.width) * 100}%`,
                                          top: `${(group.y / size.height) * 100}%`,
                                          width: `${(group.width / size.width) * 100}%`,
                                          height: `${(group.height / size.height) * 100}%`,
                                          clipPath: clip,
                                      }}
                                  >
                                      {translated[index]?.text ?? group.lines.join('')}
                                  </span>
                              );
                          })
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
                                {translated ? <p className="target">{translated[index]?.text ?? ''}</p> : null}
                            </li>
                        ))}
                    </ol>
                </section>
            ) : null}


            {showDebug ? (
                <section className="debug">
                    <h2>Stages</h2>
                    <div className="debug-grid">
                        <figure>
                            {erasedUrl ? <img src={erasedUrl} alt="Page after the erase" /> : <p>Press Detect boxes first.</p>}
                            <figcaption>erased page</figcaption>
                        </figure>
                        <figure>
                            {typesetUrl ? <img src={typesetUrl} alt="Page after the typesetting" /> : <p>Press Translate the page first.</p>}
                            <figcaption>typeset</figcaption>
                        </figure>
                    </div>
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
