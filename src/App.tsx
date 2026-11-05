import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'pickedImageUrl';

export default function App() {
  const [url, setUrl] = useState<string | null>(null);
  const [message, setMessage] = useState('No image picked yet.');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    chrome.storage.session
      .get(STORAGE_KEY)
      .then((stored) => {
        const value = stored[STORAGE_KEY];
        if (typeof value === 'string' && value.length > 0) {
          setUrl(value);
          setMessage('Picked from the page.');
        }
      })
      .catch(() => setError('Cannot read the stored URL.'));
  }, []);

  const handlePick = useCallback(async () => {
    setError(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('There is no active tab.');
      console.log('Executing pickImage.js in tab', tab.id);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['pickImage.js'] });
      window.close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  return (
    <main>
      <h1>Comic Translator</h1>
      <p>{message}</p>
      <button type="button" onClick={handlePick}>Pick an image on this page</button>
      {error ? <p role="alert">{error}</p> : null}
      {url ? (
        <figure>
          <img src={url} alt="Picked from the page" />
          <code>{url}</code>
        </figure>
      ) : null}
    </main>
  );
}
