import { useCallback, useEffect, useState } from 'react';
import { PICKED_IMAGE_URL_KEY } from './shared/constants';
import {
  LAST_RESULT_KEY,
  SERVICE_WORKER_TARGET,
  type BoxData,
  type DetectResponse,
} from './shared/messages';

type LastResult = { url: string; boxes: BoxData[]; ms: number };

export default function App() {
  const [url, setUrl] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<BoxData[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [status, setStatus] = useState('No image picked yet.');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      chrome.storage.local.get(PICKED_IMAGE_URL_KEY),
      chrome.storage.session.get(LAST_RESULT_KEY),
    ])
      .then(([local, session]) => {
        const picked = local[PICKED_IMAGE_URL_KEY];
        const last = session[LAST_RESULT_KEY] as LastResult | undefined;

        if (typeof picked !== 'string' || picked.length === 0) return;
        setUrl(picked);

        if (last && last.url === picked && Array.isArray(last.boxes)) {
          setBoxes(last.boxes);
          setStatus(`Restored ${last.boxes.length} boxes from ${last.ms} ms.`);
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
    if (!url) return;
    setBusy(true);
    setError(null);
    setBoxes([]);
    setStatus('Asking the background worker.');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const pageUrl = tab?.url?.startsWith('http') ? tab.url : undefined;

      const response = (await chrome.runtime.sendMessage({
        target: SERVICE_WORKER_TARGET,
        type: 'detect',
        url,
        pageUrl,
      })) as DetectResponse | undefined;

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
  }, [url]);

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
          disabled={!url || busy}
          data-busy={busy}
          title={url ? undefined : 'Pick an image on the page first.'}
        >
          {busy ? 'Working' : 'Detect boxes'}
        </button>
      </div>

      {error ? <p role="alert">{error}</p> : null}

      {url ? (
        <div className="stage" key={boxes?.length || 0}>
          <img
            src={url}
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
