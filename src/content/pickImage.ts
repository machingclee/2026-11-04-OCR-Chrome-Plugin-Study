const STORAGE_KEY = 'pickedImageUrl';
const HIGHLIGHT_ID = 'comic-translator-highlight';
const TOAST_ID = 'comic-translator-toast';

declare global {
  interface Window {
    __comicTranslatorPickerActive?: boolean;
  }
}

function showToast(message: string): void {
  document.getElementById(TOAST_ID)?.remove();

  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  toast.textContent = message;
  toast.style.position = 'fixed';
  toast.style.left = '50%';
  toast.style.bottom = '24px';
  toast.style.transform = 'translateX(-50%)';
  toast.style.maxWidth = '80vw';
  toast.style.padding = '8px 12px';
  toast.style.borderRadius = '6px';
  toast.style.background = 'rgba(17, 17, 17, 0.92)';
  toast.style.color = '#fff';
  toast.style.font = '13px/1.4 system-ui, sans-serif';
  toast.style.zIndex = '2147483647';
  toast.style.pointerEvents = 'none';

  document.documentElement.append(toast);
  window.setTimeout(() => toast.remove(), 6000);
}

function findImageAt(x: number, y: number): HTMLImageElement | null {
  const element = document.elementFromPoint(x, y);
  const image = element?.closest('img');
  return image instanceof HTMLImageElement ? image : null;
}

function start(): void {
  const box = document.createElement('div');
  box.id = HIGHLIGHT_ID;
  box.style.position = 'fixed';
  box.style.pointerEvents = 'none';
  box.style.display = 'none';
  box.style.border = '2px solid #ff4d6d';
  box.style.borderRadius = '4px';
  box.style.background = 'rgba(255, 77, 109, 0.12)';
  box.style.zIndex = '2147483646';
  document.documentElement.append(box);

  const place = (image: HTMLImageElement | null): void => {
    if (!image) {
      box.style.display = 'none';
      return;
    }
    const rect = image.getBoundingClientRect();
    box.style.display = 'block';
    box.style.top = `${rect.top}px`;
    box.style.left = `${rect.left}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  };

  const stop = (): void => {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    box.remove();
    window.__comicTranslatorPickerActive = false;
  };

  function onMove(event: MouseEvent): void {
    place(findImageAt(event.clientX, event.clientY));
  }

  function onClick(event: MouseEvent): void {
    const image = findImageAt(event.clientX, event.clientY);
    if (!image) return;

    event.preventDefault();
    event.stopPropagation();

    const url = image.currentSrc || image.getAttribute('src') || '';
    if (!url) return;

    void chrome.storage.session.set({ [STORAGE_KEY]: url });
    showToast(`Picked ${url}`);
    stop();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') stop();
  }

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
  showToast('Pick mode is on. Click an image, or press Escape.');
}

if (!window.__comicTranslatorPickerActive) {
  window.__comicTranslatorPickerActive = true;
  start();
}

export {};
