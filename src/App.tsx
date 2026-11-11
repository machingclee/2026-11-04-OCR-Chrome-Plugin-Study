import { useCallback, useEffect, useState } from 'react';
import {
    CONTENT_SCRIPT_FILE,
    KEEP_OUTSIDE_KEY,
    DEEPSEEK_KEY,
    GEMINI_KEY,
    REPLACE_IMAGE_MESSAGE,
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
    ms: number;
};

export default function App() {
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [boxes, setBoxes] = useState<BoxData[]>([]);
    const [previews, setPreviews] = useState<string[]>([]);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [status, setStatus] = useState('No image picked yet.');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [keepOutside, setKeepOutside] = useState(true);
    const [bubbles, setBubbles] = useState<BubbleStroke[]>([]);
    const [groups, setGroups] = useState<GroupStroke[]>([]);
    const [translated, setTranslated] = useState<string[] | null>(null);
    const [translating, setTranslating] = useState(false);
    const [deepSeekKey, setDeepSeekKey] = useState('');
    const [geminiKey, setGeminiKey] = useState('');
    const [translator, setTranslator] = useState<TranslatorChoice>('gemini');
    const [dirty, setDirty] = useState(false);

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
            chrome.storage.local.get([PICKED_IMAGE_URL_KEY, KEEP_OUTSIDE_KEY]),
            chrome.storage.session.get(LAST_RESULT_KEY),
        ])
            .then(([local, session]) => {
                const pickedImageUrl = local[PICKED_IMAGE_URL_KEY];
                setKeepOutside(local[KEEP_OUTSIDE_KEY] !== false);
                const storedDeepSeek = local[DEEPSEEK_KEY];
                if (typeof storedDeepSeek === 'string') setDeepSeekKey(storedDeepSeek);
                const storedGemini = local[GEMINI_KEY];
                if (typeof storedGemini === 'string') setGeminiKey(storedGemini);
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

    const handleWriteBack = useCallback(async () => {
        if (!translated || groups.length === 0 || !imageUrl) return;
        const source = document.querySelector<HTMLImageElement>('.stage img');
        if (!source) return;

        try {
            const dataUrl = renderTypeset(
                source,
                source.naturalWidth,
                source.naturalHeight,
                groups.map((group, index) => ({
                    box: group,
                    text: translated[index] ?? group.lines.join(''),
                })),
            );
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) throw new Error('There is no active tab.');
            await chrome.tabs.sendMessage(tab.id, {
                type: REPLACE_IMAGE_MESSAGE,
                url: imageUrl,
                dataUrl,
            });
            setStatus('Wrote the translation back to the page.');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }, [groups, imageUrl, translated]);

    const handleSaveSettings = useCallback(async () => {
        await chrome.storage.local.set({
            [GEMINI_KEY]: geminiKey.trim(),
            [DEEPSEEK_KEY]: deepSeekKey.trim(),
            [TRANSLATOR_KEY]: translator,
        });
        setDirty(false);
        setStatus('Settings saved.');
    }, [deepSeekKey, geminiKey, translator]);

    const handleTranslate = useCallback(async () => {
        if (groups.length === 0) return;
        setTranslating(true);
        setError('');
        try {
            const joined = groups.map((group) => group.lines.join(''));
            const key = translator === 'gemini' ? geminiKey.trim() : deepSeekKey.trim();

            let out: string[] | null = null;
            if (translator === 'builtin') {
                out = canTranslate() ? await translateAll(joined, 'ja', 'zh-Hant') : null;
            } else if (key.length > 0) {
                out = translator === 'gemini'
                    ? await translateWithGemini(joined, key)
                    : await translateWithDeepSeek(joined, key);
            } else if (canTranslate()) {
                // No key yet, so fall back to the translator the browser ships.
                out = await translateAll(joined, 'ja', 'zh-Hant');
                setStatus('No key, so the browser translator did the work.');
            }

            if (!out) {
                setError(
                    translator === 'builtin'
                        ? 'This Chrome ships no translator. Pick Gemini or DeepSeek and paste a key.'
                        : `Paste a ${translator === 'gemini' ? 'Gemini' : 'DeepSeek'} key above.`,
                );
                return;
            }
            setTranslated(out);
            setStatus(`Translated ${out.length} groups.`);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setTranslating(false);
        }
    }, [deepSeekKey, geminiKey, groups, translator]);

    const handleDetect = useCallback(async () => {
        if (!imageUrl) return;
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
            setStatus(
                `${response.boxes.length} lines (${vertical} vertical, ${ruby} ruby), ${read} read, ${response.bubbles?.length ?? 0} balloons, ${response.groupedLines} grouped, image ${response.imageWidth}x${response.imageHeight}, ${response.ms} ms (${response.warm ? 'reused session' : 'cold session'}).`,
            );
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setStatus('Detection failed.');
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
            const request = serviceWorkerRequestFactory.ofDetection(targetImageUrl, tabPageUrl, keepOutside);
            const response = (await chrome.runtime.sendMessage(request)) as DetectResponse | undefined;
            return response;
        }

        async function getCurrentPageUrl() {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const pageUrl = tab?.url?.startsWith('http') ? tab.url : undefined;
            return pageUrl;
        }
    }, [imageUrl, keepOutside]);

    return (
        <main>
            <h1>Comic Translator</h1>
            <p>{status}</p>

            <label className="toggle">
                <input
                    type="checkbox"
                    checked={keepOutside}
                    onChange={(event) => {
                        const next = event.target.checked;
                        setKeepOutside(next);
                        void chrome.storage.local.set({ [KEEP_OUTSIDE_KEY]: next });
                    }}
                />
                Keep text outside bubbles
            </label>

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
                    disabled={boxes.length === 0 || translating}
                    title={canTranslate() ? undefined : 'This browser ships no translator.'}
                >
                    {translating ? 'Translating' : 'Translate'}
                </button>
                <button type="button" onClick={handleWriteBack} disabled={!translated}>
                    Write back to the page
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
                                      key={`group-${group.x}-${group.y}-${(translated[index] ?? '').length}`}
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
                                      {translated[index] ?? group.lines.join('')}
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
