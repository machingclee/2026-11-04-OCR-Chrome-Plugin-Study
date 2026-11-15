import {
    OVERLAY_TARGET_ATTRIBUTE,
    PICKED_IMAGE_TARGET_KEY,
    PICKED_IMAGE_URL_KEY,
    SHOW_TRANSLATION_KEY,
} from '../shared/constants';
import { clearAll, readOverlayState, toggleOverlayVisibility } from './overlay';
import serviceWorkerRequestFactory from '../shared/factories/serviceWorkerRequestFactory';
import type { BatchItem, BatchProgressMessage, BatchState, TranslateBatchResponse, TranslateResponse } from '../shared/types';
import {
    BATCH_BAR_ID,
    BATCH_MARK_ATTR,
    BOTTOM_CLEARANCE,
    HIGHLIGHT_ID,
    IMAGE_URL_PATTERN,
    SHIELD_ID,
    TOAST_ID,
} from './constants';


declare global {
    interface Window {
        __comicTranslatorPickerActive?: boolean;
        __comicTranslatorPickerControl?: {
            kind: 'single' | 'selection';
            session: string;
            end: () => void;
        };
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
    toast.style.bottom = `${BOTTOM_CLEARANCE}px`;
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
    if (element.closest(`#${BATCH_BAR_ID}`)) return true;
    return element.id === SHIELD_ID
        || element.id === HIGHLIGHT_ID
        || element.id === TOAST_ID
        || Boolean(element.closest(`[${BATCH_MARK_ATTR}]`));
}

function isBatchUi(element: Element): boolean {
    return Boolean(element.closest(`#${BATCH_BAR_ID}`) || element.closest(`#${PICK_MENU_ID}`) || element.closest(`[${BATCH_MARK_ATTR}]`) || element.closest('[data-comic-translator-batch-progress]'));
}

function absoluteUrl(value: string): string {
    if (!value) return '';
    try {
        return new URL(value, document.baseURI).href;
    } catch {
        return '';
    }
}

/** A URL another context can read later: http(s) from the network, data: inline. */
function isFetchableUrl(url: string): boolean {
    return /^https?:\/\//i.test(url) || url.startsWith('data:');
}

// A page that builds its images in JS hands the <img> a blob: URL, which only
// resolves inside the document that created it. Prefer any real URL the markup
// still carries, so the pick can be fetched again once this page is gone.
function imageUrl(image: HTMLImageElement): string {
    const candidates = [image.currentSrc, image.getAttribute('src') ?? ''];
    const srcset = image.getAttribute('srcset') ?? '';
    // A data: URL contains commas, which would break the naive srcset split.
    if (srcset && !srcset.includes('data:')) {
        const first = srcset.split(',')[0]?.trim().split(/\s+/)[0] ?? '';
        if (first) candidates.push(first);
    }
    const absolute = candidates.map(absoluteUrl).filter((url) => url.length > 0);
    return absolute.find(isFetchableUrl) ?? absolute[0] ?? '';
}

function isSpacer(image: HTMLImageElement, url: string): boolean {
    return url.startsWith('data:') && image.complete && image.naturalWidth > 0 && image.naturalWidth <= 2 && image.naturalHeight <= 2;
}

function backgroundUrl(element: Element): string {
    const value = getComputedStyle(element).backgroundImage;
    const match = /url\(["']?(.*?)["']?\)/.exec(value);
    // Resolve here: a relative url() cannot be fetched from the offscreen page.
    return match?.[1] ? absoluteUrl(match[1]) : '';
}

/** Longest side of a capture, in pixels. Detection scales down anyway. */
const CAPTURE_MAX_SIDE = 2400;

/**
 * Copy the pixels the page already decoded into a data URL. This is the only
 * way to keep a blob: image: that URL dies with the document that made it, and
 * its bytes cannot be fetched from the extension either. Drawing needs no
 * network, so hotlink and referer rules never see this request.
 */
async function captureElement(element: HTMLElement): Promise<string | null> {
    if (!(element instanceof HTMLImageElement)) return null;
    if (!element.complete) await element.decode().catch(() => undefined);
    const width = element.naturalWidth;
    const height = element.naturalHeight;
    if (width === 0 || height === 0) return null;

    const scale = Math.min(1, CAPTURE_MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    try {
        context.drawImage(element, 0, 0, canvas.width, canvas.height);
        // Lossy WebP keeps line art cleaner than JPEG at the same byte size.
        return canvas.toDataURL('image/webp', 0.9);
    } catch {
        // A cross-origin image served without CORS taints the canvas.
        return null;
    }
}

/** What the worker needs to read a picked image later. */
type PickedSource = { imageUrl: string; imageDataUrl?: string };

/**
 * Turn a hit into something the service worker can read. A message comes back
 * instead when nothing usable exists, so the caller can explain it.
 */
async function resolveSource(hit: Hit): Promise<PickedSource | string> {
    if (isFetchableUrl(hit.url)) return { imageUrl: hit.url };
    if (hit.url.startsWith('blob:')) {
        const captured = await captureElement(hit.element);
        if (captured) return { imageUrl: '', imageDataUrl: captured };
        return 'This image is served as a blob: URL and its pixels could not be copied from the page.';
    }
    return 'The picker found no readable source for this image.';
}

/**
 * What the popup restores on reopen. Local storage holds 10 MB, so only a small
 * capture is persisted; the check mark posts the pixels directly either way.
 */
const PERSISTED_CAPTURE_LIMIT = 2_000_000;

function storedPickedUrl(source: PickedSource): string {
    if (!source.imageDataUrl) return source.imageUrl;
    return source.imageDataUrl.length <= PERSISTED_CAPTURE_LIMIT ? source.imageDataUrl : '';
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

const PICK_MENU_ID = 'comic-translator-pick-menu';
const PICKER_SESSION_ATTR = 'data-comic-translator-picker-session';
const DRAG_BOX_ATTR = 'data-comic-translator-drag-box';
const STATUS_BOX_ATTR = 'data-comic-translator-status';

// A copy of this bundle injected before the last extension reload can leave
// its overlay behind in the page. Clear that frozen UI before a new session
// draws its own, otherwise old outlines, bars, and drag boxes stack up.
function removeStalePickerUi(): void {
    document.querySelectorAll(
        `#${SHIELD_ID}, #${HIGHLIGHT_ID}, #${TOAST_ID}, #${BATCH_BAR_ID}, #${PICK_MENU_ID}, ` +
        `[${BATCH_MARK_ATTR}], [${DRAG_BOX_ATTR}], [${STATUS_BOX_ATTR}], #comic-translator-pick-confirm`,
    ).forEach((node) => node.remove());
}

function claimPickerSession(): string {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    document.documentElement.setAttribute(PICKER_SESSION_ATTR, token);
    return token;
}

function ownsPickerSession(token: string): boolean {
    return document.documentElement.getAttribute(PICKER_SESSION_ATTR) === token;
}

function start(): void {
    // A new pick replaces the previous translation overlay.
    clearAll();
    removeStalePickerUi();
    const session = claimPickerSession();

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

    // The outline is a fixed box, so it goes stale as soon as the page moves.
    // Hide it while the page scrolls and restore it once the scroll settles.
    const SCROLL_SETTLE_MS = 120;
    let pointer: { x: number; y: number } | null = null;
    let scrolling = false;
    let scrollTimer: number | undefined;

    const highlightAt = (x: number, y: number): void => {
        const hit = findAt(document, x, y, 0, 0);
        place(hit && hit !== 'blocked-frame' ? hit.rect : null);
    };

    const onScroll = (): void => {
        if (!ownsPickerSession(session)) {
            stop();
            return;
        }
        if (!scrolling) {
            scrolling = true;
            place(null);
        }
        if (scrollTimer !== undefined) window.clearTimeout(scrollTimer);
        scrollTimer = window.setTimeout(() => {
            scrollTimer = undefined;
            scrolling = false;
            if (pointer) highlightAt(pointer.x, pointer.y);
        }, SCROLL_SETTLE_MS);
    };

    let confirmButton: HTMLButtonElement | null = null;
    let statusBox: HTMLElement | null = null;
    let statusTimer: number | undefined;
    let progressListener: ((message: unknown) => void) | undefined;
    let keepStatus = false;
    let followCleanup: (() => void) | null = null;
    const stop = (): void => {
        confirmButton?.remove();
        confirmButton = null;
        followCleanup?.();
        followCleanup = null;
        if (!keepStatus) statusBox?.remove();
        if (statusTimer !== undefined) window.clearInterval(statusTimer);
        if (scrollTimer !== undefined) window.clearTimeout(scrollTimer);
        if (progressListener) chrome.runtime.onMessage.removeListener(progressListener);
        window.removeEventListener('click', onClick, true);
        window.removeEventListener('contextmenu', onClick, true);
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('keydown', onKey, true);
        pointer = null;
        scrolling = false;
        shield.remove();
        box.remove();
        if (ownsPickerSession(session)) window.__comicTranslatorPickerActive = false;
        if (window.__comicTranslatorPickerControl?.session === session) {
            window.__comicTranslatorPickerControl = undefined;
        }
    };

    window.__comicTranslatorPickerControl = { kind: 'single', session, end: stop };

    function onMove(event: MouseEvent): void {
        if (!ownsPickerSession(session)) {
            stop();
            return;
        }
        pointer = { x: event.clientX, y: event.clientY };
        if (scrolling) return;
        highlightAt(event.clientX, event.clientY);
    }

    async function onClick(event: MouseEvent): Promise<void> {
        if (!ownsPickerSession(session)) {
            stop();
            return;
        }
        if ((event.target as Element).closest('#comic-translator-pick-confirm')) return;
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

        const source = await resolveSource(hit);
        if (typeof source === 'string') {
            showToast(source);
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

        const picked = hit;
        const saved = chrome.storage.local.set({
            [PICKED_IMAGE_URL_KEY]: storedPickedUrl(source),
            [PICKED_IMAGE_TARGET_KEY]: token,
        });
                confirmButton?.remove();
                const button = document.createElement('button');
                confirmButton = button;
                button.id = 'comic-translator-pick-confirm';
                button.type = 'button';
                button.title = 'Translate this image';
                button.textContent = '✓';
                const size = 44;
                const margin = 8;
                const gap = 8;
                const placeConfirm = (): void => {
                    if (!button.isConnected) return;
                    const rect = picked.element.getBoundingClientRect();
                    const visibleRight = Math.min(rect.right, window.innerWidth);
                    const visibleBottom = Math.min(rect.bottom, window.innerHeight);
                    let left = visibleRight + gap;
                    if (left + size > window.innerWidth - margin) {
                        left = Math.max(margin, visibleRight - size - gap);
                    }
                    const top = Math.min(
                        window.innerHeight - size - margin,
                        Math.max(margin, visibleBottom - size - gap),
                    );
                    button.style.left = `${left}px`;
                    button.style.top = `${top}px`;
                };
                placeConfirm();
                window.addEventListener('scroll', placeConfirm, true);
                window.addEventListener('resize', placeConfirm);
                followCleanup = () => {
                    window.removeEventListener('scroll', placeConfirm, true);
                    window.removeEventListener('resize', placeConfirm);
                };
                button.style.position = 'fixed';
                button.style.width = `${size}px`;
                button.style.height = `${size}px`;
                button.style.borderRadius = '50%';
                button.style.border = '1px solid #86efac';
                button.style.background = '#dcfce7';
                button.style.color = '#166534';
                button.style.font = '700 22px/1 system-ui, sans-serif';
                button.style.zIndex = '2147483647';
                button.style.cursor = 'pointer';
                button.style.boxShadow = '0 8px 24px rgba(15,23,42,0.35)';
                button.addEventListener('click', (clickEvent) => {
                    clickEvent.preventDefault();
                    clickEvent.stopPropagation();
                    followCleanup?.();
                    followCleanup = null;
                    button.remove();
                    confirmButton = null;

                    const started = Date.now();
                    const status = document.createElement('div');
                    status.setAttribute(STATUS_BOX_ATTR, 'true');
                    statusBox = status;
                    status.style.position = 'fixed';
                    status.style.width = '270px';
                    status.style.maxWidth = 'calc(100vw - 16px)';
                    status.style.padding = '10px 12px';
                    status.style.borderRadius = '999px';
                    status.style.background = '#ecfdf5';
                    status.style.border = '1px solid #a7f3d0';
                    status.style.color = '#065f46';
                    status.style.font = '600 13px/1.3 system-ui, sans-serif';
                    status.style.display = 'flex';
                    status.style.alignItems = 'center';
                    status.style.gap = '8px';
                    status.style.zIndex = '2147483647';
                    status.style.boxShadow = '0 8px 24px rgba(15,23,42,0.25)';
                    // A site bar owns the bottom of the window, so the pill stays
                    // above that edge even when the image runs under it.
                    const statusLeft = Math.min(window.innerWidth - 278, Math.max(8, picked.rect.right - 278));
                    const statusTop = Math.max(8, Math.min(
                        picked.rect.bottom - 52,
                        window.innerHeight - 52 - BOTTOM_CLEARANCE,
                    ));
                    status.style.left = `${statusLeft}px`;
                    status.style.top = `${statusTop}px`;

                    const spinner = document.createElement('span');
                    spinner.style.width = '14px';
                    spinner.style.height = '14px';
                    spinner.style.flex = '0 0 auto';
                    spinner.style.border = '2px solid #a7f3d0';
                    spinner.style.borderTopColor = '#059669';
                    spinner.style.borderRadius = '50%';
                    spinner.style.animation = 'comic-translator-spin 0.8s linear infinite';
                    const style = document.createElement('style');
                    style.textContent = '@keyframes comic-translator-spin { to { transform: rotate(360deg); } }';
                    document.documentElement.append(style);

                    const text = document.createElement('span');
                    text.style.flex = '1';
                    text.textContent = 'Detecting boxes ...';
                    const elapsed = document.createElement('span');
                    elapsed.style.flex = '0 0 auto';
                    elapsed.style.fontVariantNumeric = 'tabular-nums';
                    elapsed.textContent = '0 s';
                    status.append(spinner, text, elapsed);
                    document.documentElement.append(status);

                    statusTimer = window.setInterval(() => {
                        elapsed.textContent = `${Math.floor((Date.now() - started) / 1000)} s`;
                    }, 1000);

                    progressListener = (message: unknown): void => {
                        const progress = message as { kind?: string; stage?: string; provider?: string } | undefined;
                        if (progress?.kind !== 'translate-progress') return;
                        if (progress.stage === 'detecting') text.textContent = 'Detecting boxes ...';
                        if (progress.stage === 'inpainting') text.textContent = 'Inpainting ...';
                        if (progress.stage === 'calling') {
                            const provider = progress.provider === 'deepseek' ? 'DeepSeek' : progress.provider === 'gemini' ? 'Gemini' : 'translation';
                            text.textContent = `Calling ${provider}-api ...`;
                        }
                    };
                    chrome.runtime.onMessage.addListener(progressListener);

                    void chrome.runtime.sendMessage(
                        serviceWorkerRequestFactory.ofTranslation({
                            imageUrl: source.imageUrl,
                            imageDataUrl: source.imageDataUrl,
                            token,
                            tabPageUrl: location.href,
                        }),
                    ).then((response: TranslateResponse | undefined) => {
                        if (!response?.ok) throw new Error(response?.error ?? 'The background worker sent no answer.');
                        if (statusTimer !== undefined) window.clearInterval(statusTimer);
                        spinner.remove();
                        text.textContent = `Finished in ${Math.floor((Date.now() - started) / 1000)} seconds`;
                        elapsed.textContent = `${Math.floor((Date.now() - started) / 1000)} s`;
                        keepStatus = true;
                        stop();
                        window.setTimeout(() => status.remove(), 5000);
                    }).catch((cause: unknown) => {
                        status.remove();
                        statusBox = null;
                        if (statusTimer !== undefined) window.clearInterval(statusTimer);
                        if (progressListener) chrome.runtime.onMessage.removeListener(progressListener);
                        showToast(`Could not translate: ${cause instanceof Error ? cause.message : String(cause)}`);
                    });
                });
                document.documentElement.append(button);
                showToast('Image picked. Click the check mark to translate it.');
        void saved.catch((cause: unknown) => {
            const message = cause instanceof Error ? cause.message : String(cause);
            showToast(`Could not save the URL: ${message}`);
        });
    }

    function onKey(event: KeyboardEvent): void {
        if (!ownsPickerSession(session)) {
            stop();
            return;
        }
        if (event.key === 'Escape') stop();
    }

    window.addEventListener('click', onClick, true);
    window.addEventListener('contextmenu', onClick, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey, true);
    showToast('Pick mode is on. Click an image, or press Escape.');
}


type BatchSelection = {
    token: string;
    url: string;
    element: HTMLElement;
    rect: DOMRect;
};

function startBatchSelection(): void {
    if (window.__comicTranslatorPickerActive) return;
    window.__comicTranslatorPickerActive = true;
    removeStalePickerUi();
    const session = claimPickerSession();

    const selection: BatchSelection[] = [];
    let stopped = false;
    let bar: HTMLElement | null = null;
    let marks: HTMLElement | null = null;
    let pickMenu: HTMLElement | null = null;
    let markOffset = 0;
    let lastScrollY = window.scrollY;
    let scrollTimer: number | undefined;
    let dragOrigin: { x: number; y: number } | null = null;
    let dragPointer: { x: number; y: number } | null = null;
    let dragBox: HTMLElement | null = null;
    let dragScrollFrame: number | undefined;
    let dragged = false;
    let suppressClick = false;

    const shield = document.createElement('div');
    shield.id = SHIELD_ID;
    shield.style.position = 'fixed';
    shield.style.inset = '0';
    shield.style.zIndex = '2147483645';
    shield.style.background = 'transparent';
    shield.style.cursor = 'crosshair';
    document.documentElement.append(shield);

    const hover = document.createElement('div');
    hover.id = HIGHLIGHT_ID;
    hover.style.position = 'fixed';
    hover.style.pointerEvents = 'none';
    hover.style.display = 'none';
    hover.style.border = '2px solid #ff4d6d';
    hover.style.borderRadius = '4px';
    hover.style.background = 'rgba(255, 77, 109, 0.12)';
    hover.style.zIndex = '2147483646';
    document.documentElement.append(hover);

    marks = document.createElement('div');
    marks.setAttribute(BATCH_MARK_ATTR, 'layer');
    marks.style.position = 'fixed';
    marks.style.inset = '0';
    marks.style.pointerEvents = 'none';
    marks.style.zIndex = '2147483646';
    document.documentElement.append(marks);

    const placeHover = (rect: DOMRect | null): void => {
        if (!rect || rect.width === 0 || rect.height === 0) {
            hover.style.display = 'none';
            return;
        }
        hover.style.display = 'block';
        hover.style.top = `${rect.top}px`;
        hover.style.left = `${rect.left}px`;
        hover.style.width = `${rect.width}px`;
        hover.style.height = `${rect.height}px`;
    };

    // The hover outline is fixed to the viewport, so it no longer matches the
    // page while the page (or a nested scroller) moves. Hide it during scroll
    // and re-detect the image under the pointer once scrolling settles.
    let pointer: { x: number; y: number } | null = null;
    let scrolling = false;

    const isBatchUiAt = (x: number, y: number): boolean => {
        const shieldNode = document.getElementById(SHIELD_ID);
        if (shieldNode instanceof HTMLElement) shieldNode.style.pointerEvents = 'none';
        try {
            return document.elementsFromPoint(x, y).some((node) => isBatchUi(node));
        } finally {
            if (shieldNode instanceof HTMLElement) shieldNode.style.pointerEvents = 'auto';
        }
    };

    const refreshHover = (): void => {
        if (!pointer || dragOrigin) return;
        if (isBatchUiAt(pointer.x, pointer.y)) {
            placeHover(null);
            return;
        }
        const hit = findAt(document, pointer.x, pointer.y, 0, 0);
        placeHover(hit && hit !== 'blocked-frame' ? hit.rect : null);
    };

    const rectFor = (item: BatchSelection): DOMRect => {
        if (item.element.ownerDocument === document && item.element.isConnected) {
            return item.element.getBoundingClientRect();
        }
        return item.rect;
    };

    const redrawMarks = (): void => {
        if (!marks) return;
        marks.replaceChildren();
        selection.forEach((item, index) => {
            const rect = rectFor(item);
            if (rect.width < 1 || rect.height < 1) return;
            const outline = document.createElement('div');
            outline.setAttribute(BATCH_MARK_ATTR, 'outline');
            outline.style.position = 'fixed';
            outline.style.left = `${rect.left}px`;
            outline.style.top = `${rect.top}px`;
            outline.style.width = `${rect.width}px`;
            outline.style.height = `${rect.height}px`;
            outline.style.border = '2px solid #16a34a';
            outline.style.borderRadius = '4px';
            // A page-wide tint would stack once many images are selected;
            // keep the emphasis local to each outline instead.
            outline.style.boxShadow = '0 0 0 3px rgba(22, 163, 74, 0.22)';
            const badge = document.createElement('span');
            badge.textContent = `✓ ${index + 1}`;
            badge.style.position = 'absolute';
            badge.style.right = '-10px';
            badge.style.top = '8px';
            badge.style.width = '38px';
            badge.style.height = '22px';
            badge.style.borderRadius = '11px';
            badge.style.background = '#16a34a';
            badge.style.color = '#fff';
            badge.style.font = '600 11px/22px system-ui, sans-serif';
            badge.style.textAlign = 'center';
            badge.style.pointerEvents = 'auto';
            badge.style.cursor = 'pointer';
            badge.title = selection.length > 1 ? 'Translate all' : 'Translate this image';
            badge.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                void confirmSelection();
            });
            outline.append(badge);
            marks?.append(outline);
        });
        if (bar) {
            const button = bar.querySelector<HTMLButtonElement>('[data-action="translate"]');
            const count = bar.querySelector<HTMLElement>('[data-count]');
            if (count) count.textContent = `${selection.length} selected`;
            if (button) {
                button.textContent = selection.length > 0
                    ? `✓ Translate ${selection.length} image${selection.length === 1 ? '' : 's'}`
                    : '✓ Translate selected';
                button.disabled = selection.length === 0;
            }
        }
    };

    const makeBar = (): void => {
        if (bar) return;
        bar = document.createElement('div');
        bar.id = BATCH_BAR_ID;
        bar.style.position = 'fixed';
        bar.style.left = '50%';
        bar.style.bottom = `${BOTTOM_CLEARANCE}px`;
        bar.style.transform = 'translateX(-50%)';
        bar.style.zIndex = '2147483647';
        bar.style.display = 'flex';
        bar.style.alignItems = 'center';
        bar.style.gap = '10px';
        bar.style.padding = '10px 12px';
        bar.style.borderRadius = '10px';
        bar.style.background = 'rgba(17, 17, 17, 0.95)';
        bar.style.color = '#fff';
        bar.style.font = '13px/1.3 system-ui, sans-serif';
        bar.style.boxShadow = '0 6px 24px rgba(0, 0, 0, 0.28)';
        bar.style.pointerEvents = 'auto';

        const count = document.createElement('span');
        count.setAttribute('data-count', 'true');
        const translate = document.createElement('button');
        translate.type = 'button';
        translate.setAttribute('data-action', 'translate');
        translate.style.border = '0';
        translate.style.borderRadius = '6px';
        translate.style.padding = '7px 10px';
        translate.style.background = '#2f7bd8';
        translate.style.color = '#fff';
        translate.style.cursor = 'pointer';
        translate.style.font = 'inherit';
        translate.addEventListener('click', (event) => {
            event.stopPropagation();
            void confirmSelection();
        });

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        cancel.style.border = '1px solid rgba(255,255,255,0.35)';
        cancel.style.borderRadius = '6px';
        cancel.style.padding = '6px 9px';
        cancel.style.background = 'transparent';
        cancel.style.color = '#fff';
        cancel.style.cursor = 'pointer';
        cancel.style.font = 'inherit';
        cancel.addEventListener('click', (event) => {
            event.stopPropagation();
            finish(false);
        });

        bar.append(count, translate, cancel);
        bar.addEventListener('click', (event) => event.stopPropagation());
        bar.style.display = 'none';
        document.documentElement.append(bar);
    };

    const onScroll = (): void => {
        if (!ownsPickerSession(session)) {
            finish(false);
            return;
        }
        const next = window.scrollY;
        markOffset += lastScrollY - next;
        lastScrollY = next;
        if (!scrolling) {
            scrolling = true;
            placeHover(null);
        }
        if (marks) marks.style.transform = `translateY(${markOffset}px)`;
        if (dragOrigin) drawDragBox();
        if (scrollTimer !== undefined) window.clearTimeout(scrollTimer);
        scrollTimer = window.setTimeout(() => {
            if (marks) marks.style.transform = '';
            markOffset = 0;
            scrolling = false;
            redrawMarks();
            refreshHover();
        }, 120);
    };

    const finish = (keepTokens: boolean): void => {
        if (stopped) return;
        stopped = true;
        window.removeEventListener('click', onClick, true);
        window.removeEventListener('contextmenu', onClick, true);
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('mousedown', onDragStart, true);
        window.removeEventListener('mousemove', onDragMove, true);
        window.removeEventListener('mouseup', onDragEnd, true);
        window.removeEventListener('keydown', onKey, true);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('mouseleave', onDragLeave);
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', redrawMarks);
        if (scrollTimer !== undefined) window.clearTimeout(scrollTimer);
        stopDragScroll();
        dragBox?.remove();
        dragBox = null;
        dragOrigin = null;
        dragPointer = null;
        dragged = false;
        scrolling = false;
        pointer = null;
        shield.remove();
        hover.remove();
        closePickMenu();
        bar?.remove();
        marks?.remove();
        bar = null;
        marks = null;
        if (ownsPickerSession(session)) window.__comicTranslatorPickerActive = false;
        if (!keepTokens) {
            for (const item of selection) {
                if (item.element.getAttribute(OVERLAY_TARGET_ATTRIBUTE) === item.token) {
                    item.element.removeAttribute(OVERLAY_TARGET_ATTRIBUTE);
                }
            }
            selection.length = 0;
        }
        if (window.__comicTranslatorPickerControl?.session === session) {
            window.__comicTranslatorPickerControl = undefined;
        }
    };

    window.__comicTranslatorPickerControl = {
        kind: 'selection',
        session,
        end: () => finish(false),
    };

    const confirmSelection = async (): Promise<void> => {
        if (selection.length === 0) {
            showToast('Select at least one image.');
            return;
        }
        // Pixels are captured one image at a time, so a single blob: page does
        // not lose the whole batch. Unreadable images are reported, not queued.
        const items: BatchItem[] = [];
        let unreadable = 0;
        for (const item of selection) {
            const source = await resolveSource({ url: item.url, rect: item.rect, element: item.element });
            if (typeof source === 'string') {
                unreadable += 1;
                continue;
            }
            items.push({ imageUrl: source.imageUrl, token: item.token, imageDataUrl: source.imageDataUrl });
        }
        const skipped = unreadable > 0 ? `; skipped ${unreadable} that could not be read` : '';
        if (items.length === 0) {
            showToast(`Could not read the selected image${selection.length === 1 ? '' : 's'}.`);
            return;
        }
        finish(true);
        try {
            const response = (await chrome.runtime.sendMessage(
                serviceWorkerRequestFactory.ofBatch(items),
            )) as TranslateBatchResponse | undefined;
            if (!response) throw new Error('The background worker sent no answer.');
            if (!response.ok) throw new Error(response.error);
            showToast(`Queued ${response.count} image${response.count === 1 ? '' : 's'}${skipped}.`);
        } catch (cause) {
            showToast(`Could not queue the batch: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
    };

    function onMove(event: MouseEvent): void {
        if (!ownsPickerSession(session)) {
            finish(false);
            return;
        }
        pointer = { x: event.clientX, y: event.clientY };
        if (scrolling) return;
        if (dragOrigin) {
            placeHover(null);
            return;
        }
        if (isBatchUi(event.target as Element)) {
            placeHover(null);
            return;
        }
        const hit = findAt(document, event.clientX, event.clientY, 0, 0);
        placeHover(hit && hit !== 'blocked-frame' ? hit.rect : null);
    }

    function toggleHit(hit: Exclude<ReturnType<typeof findAt>, 'blocked-frame' | null>): void {
        const existing = selection.findIndex((item) =>
            item.element === hit.element
            || (item.url === hit.url && Math.abs(item.rect.top - hit.rect.top) < 1
                && Math.abs(item.rect.left - hit.rect.left) < 1));
        if (existing >= 0) {
            selection[existing].element.removeAttribute(OVERLAY_TARGET_ATTRIBUTE);
            selection.splice(existing, 1);
        } else {
            const token = `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            hit.element.setAttribute(OVERLAY_TARGET_ATTRIBUTE, token);
            selection.push({ token, url: hit.url, element: hit.element, rect: hit.rect });
        }
        redrawMarks();
    }

    function unselectAll(): void {
        for (const item of selection) item.element.removeAttribute(OVERLAY_TARGET_ATTRIBUTE);
        selection.length = 0;
        redrawMarks();
    }

    const closePickMenu = (): void => {
        pickMenu?.remove();
        pickMenu = null;
    };

    function showPickMenu(x: number, y: number): void {
        closePickMenu();
        const menu = document.createElement('div');
        pickMenu = menu;
        menu.id = PICK_MENU_ID;
        menu.setAttribute('popover', 'manual');
        menu.style.position = 'fixed';
        menu.style.margin = '0';
        // Width plus padding and border is 234px; keep the taller three-item
        // menu inside the viewport as well.
        menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 242))}px`;
        menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 150))}px`;
        menu.style.width = '220px';
        menu.style.padding = '6px';
        menu.style.borderRadius = '8px';
        menu.style.background = '#fffaf3';
        menu.style.border = '1px solid #e2d1bd';
        menu.style.boxShadow = '0 10px 30px rgba(15,23,42,0.25)';
        menu.style.zIndex = '2147483647';
        menu.style.pointerEvents = 'auto';
        menu.style.isolation = 'isolate';
        menu.style.userSelect = 'none';
        menu.style.font = '13px/1.3 system-ui, sans-serif';
        const icons = {
            unselectAll: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M6 18L18 6"/></svg>',
            translate: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M6 4.5h9.2a2 2 0 0 1 2 2V13a2 2 0 0 1-2 2H9.2L6 17.6V15H5.2a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z"/><path d="M8.1 7.4v4.6M11.1 7.4v4.6M14.1 7.4v4.6"/></svg>',
            visibility: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.7 12S6 5.8 12 5.8 21.3 12 21.3 12 18 18.2 12 18.2 2.7 12 2.7 12z"/><circle cx="12" cy="12" r="2.7"/></svg>',
        };
        const addDivider = () => {
            const divider = document.createElement('div');
            divider.setAttribute('role', 'separator');
            divider.style.height = '1px';
            divider.style.margin = '4px 6px';
            divider.style.background = '#e2d1bd';
            menu.append(divider);
        };
        const addItem = (
            label: string,
            run: () => void,
            icon: string,
            options: { enabled?: boolean; hint?: string } = {},
        ) => {
            const enabled = options.enabled !== false;
            const item = document.createElement('button');
            item.type = 'button';
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.gap = '9px';
            item.style.width = '100%';
            item.style.padding = '8px';
            item.style.border = '0';
            item.style.borderRadius = '5px';
            item.style.background = 'transparent';
            item.style.color = '#4a3828';
            item.style.textAlign = 'left';
            item.style.cursor = 'pointer';
            item.style.pointerEvents = 'auto';
            item.style.transition = 'background 120ms ease, color 120ms ease';
            if (!enabled) {
                // Keep the row in the menu so the control stays discoverable
                // on a page that has nothing to show yet.
                item.disabled = true;
                item.style.opacity = '0.45';
                item.style.cursor = 'default';
                if (options.hint) item.title = options.hint;
            }
            const iconNode = document.createElement('span');
            iconNode.innerHTML = icon;
            iconNode.style.display = 'inline-flex';
            iconNode.style.flex = '0 0 auto';
            iconNode.style.color = '#8a6a4f';
            const textNode = document.createElement('span');
            textNode.textContent = label;
            item.append(iconNode, textNode);
            item.addEventListener('mouseenter', () => {
                if (!enabled) return;
                item.style.background = '#f5e7d7';
                item.style.color = '#3f2f22';
            });
            item.addEventListener('mouseleave', () => {
                if (!enabled) return;
                item.style.background = 'transparent';
                item.style.color = '#4a3828';
            });
            item.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!enabled) return;
                closePickMenu();
                run();
            });
            menu.append(item);
        };
        addItem(`Translate selected (${selection.length})`, () => { void confirmSelection(); }, icons.translate);
        addDivider();
        addItem('Unselect all', unselectAll, icons.unselectAll);
        addDivider();
        const overlay = readOverlayState();
        addItem('Show/Hide Translation', () => {
            const visible = toggleOverlayVisibility();
            if (visible !== null) {
                // The popup switch reads the same flag, so keep it in step.
                void chrome.storage.local.set({ [SHOW_TRANSLATION_KEY]: visible }).catch(() => undefined);
            }
        }, icons.visibility, {
            enabled: overlay.present,
            hint: 'Translate this page first.',
        });
        menu.addEventListener('contextmenu', (event) => event.preventDefault());
        document.documentElement.append(menu);
        try {
            (menu as HTMLElement & { showPopover?: () => void }).showPopover?.();
        } catch {
            // Fall back to the fixed z-index when popover is unavailable.
        }
    }

    function onClick(event: MouseEvent): void {
        if (!ownsPickerSession(session)) {
            finish(false);
            return;
        }
        if (suppressClick) {
            suppressClick = false;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        if (isBatchUi(event.target as Element)) return;
        event.preventDefault();
        event.stopPropagation();

        if (event.type === 'contextmenu') {
            showPickMenu(event.clientX, event.clientY);
            return;
        }

        // The menu is a popover: a click outside it only dismisses it.
        if (pickMenu) {
            closePickMenu();
            return;
        }

        const hit = findAt(document, event.clientX, event.clientY, 0, 0);
        if (hit === 'blocked-frame') {
            showToast('This image is inside a frame the picker cannot read.');
            return;
        }
        if (!hit) return;
        toggleHit(hit);
    }

    // The rectangle lives in page coordinates, not viewport coordinates, so
    // scrolling during a drag keeps everything the rectangle has swept over.
    const DRAG_EDGE = 64;
    const DRAG_MAX_STEP = 18;

    function dragPageRect(pointer: { x: number; y: number }): { left: number; top: number; right: number; bottom: number } | null {
        if (!dragOrigin) return null;
        const x = pointer.x + window.scrollX;
        const y = pointer.y + window.scrollY;
        return {
            left: Math.min(dragOrigin.x, x),
            top: Math.min(dragOrigin.y, y),
            right: Math.max(dragOrigin.x, x),
            bottom: Math.max(dragOrigin.y, y),
        };
    }

    function drawDragBox(): void {
        if (!dragPointer) return;
        const rect = dragPageRect(dragPointer);
        if (!rect) return;
        if (!dragBox) {
            dragBox = document.createElement('div');
            dragBox.setAttribute(DRAG_BOX_ATTR, 'true');
            dragBox.style.position = 'fixed';
            dragBox.style.border = '1px dashed #b3815c';
            dragBox.style.background = 'rgba(179, 129, 92, 0.12)';
            dragBox.style.pointerEvents = 'none';
            dragBox.style.zIndex = '2147483646';
            document.documentElement.append(dragBox);
        }
        dragBox.style.left = `${rect.left - window.scrollX}px`;
        dragBox.style.top = `${rect.top - window.scrollY}px`;
        dragBox.style.width = `${rect.right - rect.left}px`;
        dragBox.style.height = `${rect.bottom - rect.top}px`;
    }

    function stopDragScroll(): void {
        if (dragScrollFrame !== undefined) {
            window.cancelAnimationFrame(dragScrollFrame);
            dragScrollFrame = undefined;
        }
    }

    // Dragging near the top or bottom edge scrolls the page, so the rectangle
    // can keep growing past the images that were visible when it started.
    function stepDragScroll(): void {
        dragScrollFrame = undefined;
        if (!ownsPickerSession(session)) {
            finish(false);
            return;
        }
        if (!dragOrigin || !dragPointer) return;
        dragScrollFrame = window.requestAnimationFrame(stepDragScroll);
        if (!dragged) return;
        let step = 0;
        if (dragPointer.y < DRAG_EDGE) {
            step = -Math.ceil((DRAG_EDGE - dragPointer.y) / 4);
        } else if (dragPointer.y > window.innerHeight - DRAG_EDGE) {
            step = Math.ceil((dragPointer.y - (window.innerHeight - DRAG_EDGE)) / 4);
        }
        if (step === 0) return;
        step = Math.max(-DRAG_MAX_STEP, Math.min(DRAG_MAX_STEP, step));
        window.scrollBy(0, step);
        drawDragBox();
    }

    function onDragStart(event: MouseEvent): void {
        if (!ownsPickerSession(session)) {
            finish(false);
            return;
        }
        if (event.button !== 0 || isBatchUi(event.target as Element)) return;
        stopDragScroll();
        dragOrigin = { x: event.clientX + window.scrollX, y: event.clientY + window.scrollY };
        dragPointer = { x: event.clientX, y: event.clientY };
        dragged = false;
        stepDragScroll();
    }

    function onDragMove(event: MouseEvent): void {
        if (!ownsPickerSession(session)) {
            finish(false);
            return;
        }
        if (!dragOrigin || (event.buttons & 1) === 0) return;
        dragPointer = { x: event.clientX, y: event.clientY };
        const rect = dragPageRect(dragPointer);
        if (!rect) return;
        const width = rect.right - rect.left;
        const height = rect.bottom - rect.top;
        if (width < 6 && height < 6) return;
        if (!dragged) closePickMenu();
        dragged = true;
        event.preventDefault();
        if (dragScrollFrame === undefined) stepDragScroll();
        drawDragBox();
    }

    // If the pointer leaves the window mid-drag, stop scrolling so a lost
    // mouseup cannot leave the page auto-scrolling forever.
    function onDragLeave(): void {
        stopDragScroll();
    }

    function onDragEnd(event: MouseEvent): void {
        if (!ownsPickerSession(session)) {
            finish(false);
            return;
        }
        stopDragScroll();
        if (!dragOrigin) return;
        const origin = dragOrigin;
        const release = { x: event.clientX, y: event.clientY };
        dragOrigin = null;
        dragPointer = null;
        dragBox?.remove();
        dragBox = null;
        const wasDragged = dragged;
        dragged = false;
        if (!wasDragged) return;
        suppressClick = true;
        window.setTimeout(() => { suppressClick = false; }, 0);
        const scrollX = window.scrollX;
        const scrollY = window.scrollY;
        const currentX = release.x + scrollX;
        const currentY = release.y + scrollY;
        const left = Math.min(origin.x, currentX);
        const right = Math.max(origin.x, currentX);
        const top = Math.min(origin.y, currentY);
        const bottom = Math.max(origin.y, currentY);
        for (const image of document.images) {
            const rect = image.getBoundingClientRect();
            const imageLeft = rect.left + scrollX;
            const imageTop = rect.top + scrollY;
            if (imageLeft + rect.width < left || imageLeft > right) continue;
            if (imageTop + rect.height < top || imageTop > bottom) continue;
            const url = imageUrl(image);
            // A blob: URL is still worth selecting: the pixels are captured
            // when the batch is queued, not when the rectangle is drawn.
            if (!url) continue;
            if (selection.some((item) => item.element === image || item.url === url)) continue;
            const token = `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            image.setAttribute(OVERLAY_TARGET_ATTRIBUTE, token);
            selection.push({ token, url, element: image, rect });
        }
        redrawMarks();
    }

    function onKey(event: KeyboardEvent): void {
        if (!ownsPickerSession(session)) {
            finish(false);
            return;
        }
        if (event.key === 'Escape') finish(false);
    }

    window.addEventListener('click', onClick, true);
    window.addEventListener('contextmenu', onClick, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('mousedown', onDragStart, true);
    window.addEventListener('mousemove', onDragMove, true);
    window.addEventListener('mouseup', onDragEnd, true);
    document.addEventListener('mouseleave', onDragLeave);
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', redrawMarks);
    makeBar();
    redrawMarks();
    showToast('Selection mode: drag over images to select several, or click one, then click a green badge to translate. Escape cancels.');
}

// The same bundle is injected for the overlay, so the popup starts the picker
// explicitly through this handle; importing the bundle must not open pick mode.
const pickerScope = window as unknown as {
    __comicTranslatorPicker?: { start: () => boolean; startSelection: () => boolean };
};
pickerScope.__comicTranslatorPicker = {
    start: () => {
        // Picking one image replaces an open selection session, so the popup's
        // pick still works after images have been selected.
        window.__comicTranslatorPickerControl?.end();
        if (window.__comicTranslatorPickerActive) return false;
        window.__comicTranslatorPickerActive = true;
        start();
        return true;
    },
    startSelection: () => {
        // A pending single pick is replaced, but a selection in progress is
        // kept so an accidental shortcut press cannot wipe it.
        const control = window.__comicTranslatorPickerControl;
        if (control?.kind === 'single') control.end();
        if (window.__comicTranslatorPickerActive) return false;
        startBatchSelection();
        return true;
    },
};

type BatchProgressUi = {
    element: HTMLElement;
    text: HTMLElement;
    cancel: HTMLButtonElement;
    hideTimer?: number;
};

let batchProgressUi: BatchProgressUi | null = null;
let batchStage = '';
let batchRunningIndex = -1;

function stagePhrase(stage: string, provider?: string): string {
    if (stage === 'detecting') return 'Detecting boxes';
    if (stage === 'inpainting') return 'Inpainting';
    if (stage === 'calling') {
        if (provider === 'deepseek') return 'DeepSeek API translating';
        if (provider === 'gemini') return 'Gemini API translating';
        return 'Browser translating';
    }
    return '';
}

function updateBatchProgress(state: BatchState): void {
    if (!batchProgressUi) {
        const element = document.createElement('div');
        element.setAttribute('data-comic-translator-batch-progress', 'true');
        element.style.position = 'fixed';
        element.style.right = '18px';
        element.style.bottom = `${BOTTOM_CLEARANCE}px`;
        element.style.zIndex = '2147483647';
        element.style.display = 'flex';
        element.style.alignItems = 'center';
        element.style.gap = '10px';
        element.style.padding = '9px 11px';
        element.style.borderRadius = '8px';
        element.style.background = 'rgba(17, 17, 17, 0.95)';
        element.style.color = '#fff';
        element.style.font = '12px/1.35 system-ui, sans-serif';
        element.style.boxShadow = '0 5px 18px rgba(0, 0, 0, 0.25)';
        element.style.pointerEvents = 'auto';
        const text = document.createElement('span');
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        cancel.style.border = '1px solid rgba(255,255,255,0.35)';
        cancel.style.borderRadius = '5px';
        cancel.style.padding = '4px 7px';
        cancel.style.background = 'transparent';
        cancel.style.color = '#fff';
        cancel.style.cursor = 'pointer';
        cancel.style.font = 'inherit';
        element.append(text, cancel);
        document.documentElement.append(element);
        batchProgressUi = { element, text, cancel };
    }
    const ui = batchProgressUi;
    const total = state.items.length;
    const done = state.items.filter((item) => item.status === 'done').length;
    const failed = state.items.filter((item) => item.status === 'error').length;
    const running = state.items.findIndex((item) => item.status === 'running');
    if (running !== batchRunningIndex) {
        batchRunningIndex = running;
        batchStage = '';
    }
    if (state.status === 'done') {
        batchStage = '';
        batchRunningIndex = -1;
        ui.text.textContent = `Batch done: ${done}/${total}${failed ? `, ${failed} failed` : ''}`;
        ui.cancel.style.display = 'none';
        window.clearTimeout(ui.hideTimer);
        ui.hideTimer = window.setTimeout(() => {
            ui.element.remove();
            batchProgressUi = null;
        }, 6000);
    } else if (state.status === 'cancelled') {
        batchStage = '';
        batchRunningIndex = -1;
        ui.text.textContent = `Batch cancelled: ${done}/${total}`;
        ui.cancel.style.display = 'none';
        window.clearTimeout(ui.hideTimer);
        ui.hideTimer = window.setTimeout(() => {
            ui.element.remove();
            batchProgressUi = null;
        }, 4000);
    } else {
        ui.cancel.style.display = '';
        const count = running >= 0
            ? `Processing ${Math.min(done + 1, total)}/${total} images`
            : `Queued ${total} images...`;
        ui.text.textContent = running >= 0 && batchStage ? `${count} · ${batchStage}` : count;
        ui.cancel.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            ui.cancel.disabled = true;
            void chrome.runtime.sendMessage(serviceWorkerRequestFactory.ofCancel(state.id)).then((response: { ok?: boolean } | undefined) => {
                if (!response?.ok) ui.cancel.disabled = false;
            }).catch(() => {
                ui.cancel.disabled = false;
            });
        };
    }
}

const batchWindow = window as unknown as { __comicTranslatorBatchListener?: boolean };
if (!batchWindow.__comicTranslatorBatchListener) {
    batchWindow.__comicTranslatorBatchListener = true;
    chrome.runtime.onMessage.addListener((message: unknown) => {
        const progress = message as BatchProgressMessage | { kind?: string; stage?: string; provider?: string } | undefined;
        if (progress && 'kind' in progress && progress.kind === 'translate-progress' && typeof progress.stage === 'string') {
            const phrase = stagePhrase(progress.stage, progress.provider);
            if (phrase && batchProgressUi) {
                batchStage = phrase;
                const current = batchProgressUi.text.textContent ?? '';
                const count = current.split(' · ')[0];
                if (count.startsWith('Processing ') || count.startsWith('Queued ')) {
                    batchProgressUi.text.textContent = `${count} · ${batchStage}`;
                }
            }
            return false;
        }
        if (!progress || !('type' in progress) || progress.type !== 'batch-progress') return false;
        updateBatchProgress(progress.state);
        return false;
    });
}

export { };
