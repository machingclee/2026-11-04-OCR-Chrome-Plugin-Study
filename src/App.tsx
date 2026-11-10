import { useCallback, useEffect, useState } from 'react';
import { PICKED_IMAGE_URL_KEY } from './shared/constants';
import {
  LAST_RESULT_KEY,
  SERVICE_WORKER_TARGET,
  type BoxData,
  type DetectRequest,
  type DetectResponse,
} from './shared/messages';

type LastResult = { imageUrl: string; boxes: BoxData[]; ms: number };

export default function App() {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<BoxData[]>([]);
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
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['pickImage.js'] });
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
    setStatus('Asking the background worker.');

    try {
      const tabPageUrl = await getCurrentPageUrl();
      const response = await dispatchDetectionRequest(tabPageUrl, imageUrl);

      if (!response) throw new Error('The background worker sent no answer.');
      if (!response.ok) throw new Error(response.error);

      setBoxes(response.boxes);
      setStatus(
        `${response.boxes.length} boxes in ${response.ms} ms (${response.warm ? 'reused session' : 'cold session'}).`,
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
    async function dispatchDetectionRequest(
      tabPageUrl: string | undefined,
      targetImageUrl: string
    ) {
      if (!targetImageUrl) {
        return
      }

      const request: DetectRequest = {
        target: SERVICE_WORKER_TARGET,
        type: 'detect',
        imageUrl: targetImageUrl,
        tabPageUrl,
      };

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
    </main>
  );
}
