import {
    OVERLAY_TARGET_ATTRIBUTE,
    PICKED_IMAGE_TARGET_KEY,
    PICKED_IMAGE_URL_KEY,
} from '../shared/constants';
import { clearAll } from './overlay';
import { HIGHLIGHT_ID, IMAGE_URL_PATTERN, SHIELD_ID, TOAST_ID } from './constants';


declare global {
    interface Window {
        __comicTranslatorPickerActive?: boolean;
    }
}

type Hit = { url: string; rect: DOMRect; element: HTMLElement };

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

function isPickerUi(element: Element): boolean {
    return element.id === SHIELD_ID || element.id === HIGHLIGHT_ID || element.id === TOAST_ID;
}

function absoluteUrl(value: string): string {
    if (!value) return '';
    try {
        return new URL(value, document.baseURI).href;
    } catch {
        return '';
    }
}

function imageUrl(image: HTMLImageElement): string {
    const raw =
        image.currentSrc ||
        image.getAttribute('src') ||
        image.getAttribute('srcset')?.split(',')[0]?.trim().split(/\s+/)[0] ||
        '';
    return absoluteUrl(raw);
}

function isSpacer(image: HTMLImageElement, url: string): boolean {
    return url.startsWith('data:') && image.complete && image.naturalWidth > 0 && image.naturalWidth <= 2 && image.naturalHeight <= 2;
}

function backgroundUrl(element: Element): string {
    const value = getComputedStyle(element).backgroundImage;
    const match = /url\(["']?(.*?)["']?\)/.exec(value);
    return match?.[1] ?? '';
}

function containsPoint(rect: DOMRect, x: number, y: number): boolean {
    return rect.width >= 8 && rect.height >= 8 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function shift(rect: DOMRect, offsetX: number, offsetY: number): DOMRect {
    return new DOMRect(rect.left + offsetX, rect.top + offsetY, rect.width, rect.height);
}

function containedImage(element: Element, x: number, y: number): HTMLImageElement | null {
    let best: HTMLImageElement | null = null;
    let bestArea = Number.POSITIVE_INFINITY;

    const consider = (image: HTMLImageElement): void => {
        const url = imageUrl(image);
        if (!url || isSpacer(image, url)) return;
        const rect = image.getBoundingClientRect();
        if (!containsPoint(rect, x, y)) return;
        const area = rect.width * rect.height;
        if (area < bestArea) {
            best = image;
            bestArea = area;
        }
    };

    if (element instanceof HTMLImageElement) consider(element);
    const roots: ParentNode[] = [element];
    if (element.shadowRoot) roots.push(element.shadowRoot);
    for (const root of roots) {
        for (const image of root.querySelectorAll('img')) {
            if (image instanceof HTMLImageElement) consider(image);
        }
    }

    return best;
}

function containedBackground(element: Element, x: number, y: number): { url: string; box: HTMLElement } | null {
    let best: { url: string; box: HTMLElement } | null = null;
    let bestArea = Number.POSITIVE_INFINITY;

    const consider = (node: Element): void => {
        if (!(node instanceof HTMLElement) || isPickerUi(node)) return;
        const rect = node.getBoundingClientRect();
        if (!containsPoint(rect, x, y)) return;
        const url = backgroundUrl(node);
        if (!url) return;
        const area = rect.width * rect.height;
        if (area < bestArea) {
            best = { url, box: node };
            bestArea = area;
        }
    };

    consider(element);
    for (const node of element.querySelectorAll('div, span, a, i')) consider(node);
    return best;
}

function findAt(doc: Document, x: number, y: number, offsetX: number, offsetY: number): Hit | 'blocked-frame' | null {
    const shield = doc.getElementById(SHIELD_ID);
    if (shield instanceof HTMLElement) shield.style.pointerEvents = 'none';

    let stack: Element[] = [];
    try {
        stack = doc.elementsFromPoint(x, y);
    } finally {
        if (shield instanceof HTMLElement && doc === document) shield.style.pointerEvents = 'auto';
    }

    for (const element of stack) {
        if (isPickerUi(element)) continue;
        if (element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement) {
            const frameRect = element.getBoundingClientRect();
            let inner: Document | null = null;
            try {
                inner = element.contentDocument;
            } catch {
                inner = null;
            }
            if (!inner) return 'blocked-frame';
            return findAt(inner, x - frameRect.left, y - frameRect.top, offsetX + frameRect.left, offsetY + frameRect.top);
        }
        if (element.tagName === 'BODY' || element.tagName === 'HTML') continue;

        const image = containedImage(element, x, y);
        if (image) {
            const rect = image.getBoundingClientRect();
            return { url: imageUrl(image), rect: shift(rect, offsetX, offsetY), element: image };
        }

        const background = containedBackground(element, x, y);
        if (background) return {
            url: background.url,
            rect: shift(background.box.getBoundingClientRect(), offsetX, offsetY),
            element: background.box,
        };

        const link = element.closest('a');
        if (link instanceof HTMLAnchorElement && IMAGE_URL_PATTERN.test(link.href)) {
            const rect = link.getBoundingClientRect();
            return { url: link.href, rect: shift(rect, offsetX, offsetY), element: link };
        }
    }

    return null;
}

function start(): void {
    // A new pick replaces the previous translation overlay.
    clearAll();

    const shield = document.createElement('div');
    shield.id = SHIELD_ID;
    shield.style.position = 'fixed';
    shield.style.inset = '0';
    shield.style.zIndex = '2147483645';
    shield.style.background = 'transparent';
    shield.style.cursor = 'crosshair';
    document.documentElement.append(shield);

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

    const place = (rect: DOMRect | null): void => {
        if (!rect || rect.width === 0 || rect.height === 0) {
            box.style.display = 'none';
            return;
        }
        box.style.display = 'block';
        box.style.top = `${rect.top}px`;
        box.style.left = `${rect.left}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
    };

    const stop = (): void => {
        shield.removeEventListener('click', onClick);
        window.removeEventListener('click', onClick, true);
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('keydown', onKey, true);
        shield.remove();
        box.remove();
        window.__comicTranslatorPickerActive = false;
    };

    function onMove(event: MouseEvent): void {
        const hit = findAt(document, event.clientX, event.clientY, 0, 0);
        place(hit && hit !== 'blocked-frame' ? hit.rect : null);
    }

    function onClick(event: MouseEvent): void {
        event.preventDefault();
        event.stopPropagation();

        const hit = findAt(document, event.clientX, event.clientY, 0, 0);
        if (hit === 'blocked-frame') {
            showToast('This image is inside a frame the picker cannot read.');
            return;
        }
        if (!hit) {
            showToast('No image under the pointer.');
            return;
        }

        if (hit.url.startsWith('blob:')) {
            showToast('This image has no stable URL, so it cannot be fetched later.');
            return;
        }

        // The URL alone is ambiguous when a page repeats the same thumbnail.
        // Mark the exact element so the overlay lands on the one that was picked.
        const owner = hit.element.ownerDocument;
        owner.querySelectorAll(`[${OVERLAY_TARGET_ATTRIBUTE}]`).forEach((node) => {
            node.removeAttribute(OVERLAY_TARGET_ATTRIBUTE);
        });
        const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        hit.element.setAttribute(OVERLAY_TARGET_ATTRIBUTE, token);

        chrome.storage.local
            .set({
                [PICKED_IMAGE_URL_KEY]: hit.url,
                [PICKED_IMAGE_TARGET_KEY]: token,
            })
            .then(() => showToast(`Picked ${hit.url}`))
            .catch((cause: unknown) => {
                const message = cause instanceof Error ? cause.message : String(cause);
                showToast(`Could not save the URL: ${message}`);
            });
        stop();
    }

    function onKey(event: KeyboardEvent): void {
        if (event.key === 'Escape') stop();
    }

    shield.addEventListener('click', onClick);
    window.addEventListener('click', onClick, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('keydown', onKey, true);
    showToast('Pick mode is on. Click an image, or press Escape.');
}

// The same bundle is injected for the overlay, so the popup starts the picker
// explicitly through this handle; importing the bundle must not open pick mode.
const pickerScope = window as unknown as {
    __comicTranslatorPicker?: { start: () => void };
};
pickerScope.__comicTranslatorPicker = {
    start: () => {
        if (window.__comicTranslatorPickerActive) return;
        window.__comicTranslatorPickerActive = true;
        start();
    },
};

export { };
