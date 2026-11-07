import { useCallback, useEffect, useState } from 'react';
import { detectBoxes, type Box } from './lib/detector';

const STORAGE_KEY = 'pickedImageUrl';

export default function App() {
  const [url, setUrl] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [status, setStatus] = useState('No image picked yet.');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    chrome.storage.local
      .get(STORAGE_KEY)
      .then((stored) => {
        const value = stored[STORAGE_KEY];
        if (typeof value === 'string' && value.length > 0) {
          setUrl(value);
          setStatus('Picked from the page. Run the detector to find boxes.');
        }
      })
      .catch(() => setError('Cannot read the stored URL.'));
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
    setStatus('Fetching the image and loading the model.');
    const started = performance.now();

    try {
      let response: Response;
      try {
        response = await fetch(url);
      } catch {
        throw new Error(`The browser blocked the request for ${url}`);
      }
      if (!response.ok) throw new Error(`Image fetch failed with ${response.status} for ${url}`);
      const bitmap = await createImageBitmap(await response.blob());
      setSize({ width: bitmap.width, height: bitmap.height });

      setStatus('Running the detector.');
      const found = await detectBoxes(bitmap);
      setBoxes(found);
      setStatus(`${found.length} boxes in ${Math.round(performance.now() - started)} ms.`);
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
        <div className="stage">
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
