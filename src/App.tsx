import { useCallback, useEffect, useState } from 'react';
import { detectBoxes, type Box } from './lib/detector';

const STORAGE_KEY = 'pickedImageUrl';
const REFERER_RULE_ID = 1;

async function fetchWithReferer(imageUrl: string, pageUrl: string): Promise<Response> {
  const host = new URL(imageUrl).hostname;
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existing.filter((rule) => rule.id === REFERER_RULE_ID).map((rule) => rule.id),
    addRules: [
      {
        id: REFERER_RULE_ID,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [{ header: 'Referer', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: pageUrl }],
        },
        condition: {
          requestDomains: [host],
          requestMethods: [chrome.declarativeNetRequest.RequestMethod.GET],
          resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
        },
      },
    ],
  });

  try {
    return await fetch(imageUrl, { credentials: 'include' });
  } catch (cause) {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const name = cause instanceof Error ? cause.name : 'Error';
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `${detail} (${name}, ${rules.length} referer rule(s) installed, referer ${pageUrl})`,
    );
  } finally {
    await chrome.declarativeNetRequest
      .updateSessionRules({ removeRuleIds: [REFERER_RULE_ID] })
      .catch(() => undefined);
  }
}

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
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const pageUrl = tab?.url?.startsWith('http') ? tab.url : undefined;

      let response: Response;
      try {
        response = pageUrl ? await fetchWithReferer(url, pageUrl) : await fetch(url);
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
