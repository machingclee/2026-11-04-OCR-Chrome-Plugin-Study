import { useCallback, useEffect, useState } from 'react';
import { CONTENT_SCRIPT_FILE, LAST_RESULT_KEY, PICKED_IMAGE_URL_KEY } from './shared/constants';
import type { BoxData, DetectResponse } from './shared/types';
import serviceWorkerRequestFactory from './shared/factories/serviceWorkerRequestFactory';

type LastResult = { imageUrl: string; boxes: BoxData[]; previews?: string[]; ms: number };

export default function App() {
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [boxes, setBoxes] = useState<BoxData[]>([]);
    const [previews, setPreviews] = useState<string[]>([]);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [status, setStatus] = useState('No image picked yet.');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        // start working when we open this popup again,
        // at this point our newly picked image url is nonempty.
        Promise.all([
            chrome.storage.local.get(PICKED_IMAGE_URL_KEY),
            chrome.storage.session.get(LAST_RESULT_KEY),
        ])
            .then(([local, session]) => {
                const pickedImageUrl = local[PICKED_IMAGE_URL_KEY];
                const lastResult = session[LAST_RESULT_KEY] as LastResult | undefined;

                if (typeof pickedImageUrl !== 'string' || pickedImageUrl.length === 0) {
                    return;
                }

                setImageUrl(pickedImageUrl);

                // don't do it again if we pick the same image
                if (lastResult && lastResult.imageUrl === pickedImageUrl && Array.isArray(lastResult.boxes)) {
                    setBoxes(lastResult.boxes);
                    setPreviews(Array.isArray(lastResult.previews) ? lastResult.previews : []);
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
            const vertical = response.boxes.filter((box) => box.direction === 'vertical').length;
            const ruby = response.boxes.reduce((sum, box) => sum + box.ruby.length, 0);
            const read = response.boxes.filter((box) => box.text.length > 0).length;
            setStatus(
                `${response.boxes.length} lines (${vertical} vertical, ${ruby} ruby), ${read} read, ${response.ms} ms (${response.warm ? 'reused session' : 'cold session'}).`,
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
                    {size.width > 0
                        ? boxes.map((box) => (
                            <span
                                key={`${box.x}-${box.y}-${box.width}-${box.height}`}
                                className="box"
                                data-direction={box.direction}
                                style={{
                                    left: `${(box.x / size.width) * 100}%`,
                                    top: `${(box.y / size.height) * 100}%`,
                                    width: `${(box.width / size.width) * 100}%`,
                                    height: `${(box.height / size.height) * 100}%`,
                                }}
                            />
                        ))
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
