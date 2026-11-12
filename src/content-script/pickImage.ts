import {
    OVERLAY_TARGET_ATTRIBUTE,
    PICKED_IMAGE_TARGET_KEY,
    PICKED_IMAGE_URL_KEY,
} from '../shared/constants';
import { clearAll } from './overlay';
import serviceWorkerRequestFactory from '../shared/factories/serviceWorkerRequestFactory';
import type { BatchProgressMessage, BatchState, TranslateBatchResponse, TranslateResponse } from '../shared/types';
import {
    BATCH_BAR_ID,
    BATCH_MARK_ATTR,
    HIGHLIGHT_ID,
    IMAGE_URL_PATTERN,
    SHIELD_ID,
    TOAST_ID,
} from './constants';


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
    if (element.closest(`#${BATCH_BAR_ID}`)) return true;
    return element.id === SHIELD_ID
        || element.id === HIGHLIGHT_ID
        || element.id === TOAST_ID
        || Boolean(element.closest(`[${BATCH_MARK_ATTR}]`));
}

function isBatchUi(element: Element): boolean {
    return Boolean(element.closest(`#${BATCH_BAR_ID}`) || element.closest(`[${BATCH_MARK_ATTR}]`) || element.closest('[data-comic-translator-batch-progress]'));
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

const PAGE_EVENTS = ['mousedown', 'auxclick', 'contextmenu', 'dragstart'] as const;

// Installed at document_start by the manifest before the page registers its
// own mousedown handlers. Rawkuma opens an ad from a window capture handler.
const PICKING_ATTR = 'data-comic-translator-picking';
const guardScope = window as unknown as { __comicTranslatorMousedownGuard?: boolean };
if (!guardScope.__comicTranslatorMousedownGuard) {
    guardScope.__comicTranslatorMousedownGuard = true;
    window.addEventListener('mousedown', (event) => {
        if (!document.documentElement.hasAttribute(PICKING_ATTR)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);
}

function swallowPageEvent(event: Event): void {
    if ((event.target as Element | null)?.closest('#comic-translator-pick-confirm')) return;
    event.preventDefault();
    event.stopPropagation();
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
        if (progressListener) chrome.runtime.onMessage.removeListener(progressListener);
        shield.removeEventListener('click', onClick);
        window.removeEventListener('click', onClick, true);
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('keydown', onKey, true);
        for (const type of PAGE_EVENTS) window.removeEventListener(type, swallowPageEvent, true);
        shield.remove();
        box.remove();
        window.__comicTranslatorPickerActive = false;
        document.documentElement.removeAttribute(PICKING_ATTR);
    };

    function onMove(event: MouseEvent): void {
        const hit = findAt(document, event.clientX, event.clientY, 0, 0);
        place(hit && hit !== 'blocked-frame' ? hit.rect : null);
    }

    function onClick(event: MouseEvent): void {
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

        const picked = hit;
        chrome.storage.local
            .set({
                [PICKED_IMAGE_URL_KEY]: picked.url,
                [PICKED_IMAGE_TARGET_KEY]: token,
            })
            .then(() => {
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
                    let left = rect.right + gap;
                    if (left + size > window.innerWidth - margin) left = rect.left - size - gap;
                    if (left < margin) {
                        left = Math.min(window.innerWidth - size - margin, Math.max(margin, rect.right - size - gap));
                    }
                    let top = Math.min(window.innerHeight - size - margin, Math.max(margin, rect.bottom - size - gap));
                    if (left + size > window.innerWidth - margin) {
                        left = Math.min(window.innerWidth - size - margin, Math.max(margin, rect.right - size - gap));
                        top = Math.min(window.innerHeight - size - margin, Math.max(margin, rect.bottom + gap));
                    }
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
                    const statusLeft = Math.min(window.innerWidth - 278, Math.max(8, picked.rect.right - 278));
                    const statusTop = Math.min(window.innerHeight - 52, Math.max(8, picked.rect.bottom - 52));
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
                            imageUrl: picked.url,
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
            })
            .catch((cause: unknown) => {
                const message = cause instanceof Error ? cause.message : String(cause);
                showToast(`Could not save the URL: ${message}`);
            });
    }

    function onKey(event: KeyboardEvent): void {
        if (event.key === 'Escape') stop();
    }

    shield.addEventListener('click', onClick);
    window.addEventListener('click', onClick, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('keydown', onKey, true);
    for (const type of PAGE_EVENTS) window.addEventListener(type, swallowPageEvent, true);
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
    document.documentElement.setAttribute(PICKING_ATTR, 'true');

    const selection: BatchSelection[] = [];
    let stopped = false;
    let bar: HTMLElement | null = null;
    let marks: HTMLElement | null = null;

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
            outline.style.border = '2px solid #2f7bd8';
            outline.style.borderRadius = '4px';
            outline.style.boxShadow = '0 0 0 9999px rgba(47, 123, 216, 0.04)';
            const badge = document.createElement('span');
            badge.textContent = String(index + 1);
            badge.style.position = 'absolute';
            badge.style.right = '-10px';
            badge.style.top = '-10px';
            badge.style.width = '20px';
            badge.style.height = '20px';
            badge.style.borderRadius = '10px';
            badge.style.background = '#2f7bd8';
            badge.style.color = '#fff';
            badge.style.font = '12px/20px system-ui, sans-serif';
            badge.style.textAlign = 'center';
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
        bar.style.bottom = '20px';
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
        document.documentElement.append(bar);
    };

    const finish = (keepTokens: boolean): void => {
        if (stopped) return;
        stopped = true;
        shield.removeEventListener('click', onClick);
        window.removeEventListener('click', onClick, true);
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', redrawMarks, true);
        window.removeEventListener('resize', redrawMarks);
        for (const type of PAGE_EVENTS) window.removeEventListener(type, swallowPageEvent, true);
        shield.remove();
        hover.remove();
        bar?.remove();
        marks?.remove();
        bar = null;
        marks = null;
        window.__comicTranslatorPickerActive = false;
        document.documentElement.removeAttribute(PICKING_ATTR);
        if (!keepTokens) {
            for (const item of selection) item.element.removeAttribute(OVERLAY_TARGET_ATTRIBUTE);
            selection.length = 0;
        }
    };

    const confirmSelection = async (): Promise<void> => {
        if (selection.length === 0) {
            showToast('Select at least one image.');
            return;
        }
        const items = selection.map((item) => ({ imageUrl: item.url, token: item.token }));
        finish(true);
        try {
            const response = (await chrome.runtime.sendMessage(
                serviceWorkerRequestFactory.ofBatch(items),
            )) as TranslateBatchResponse | undefined;
            if (!response) throw new Error('The background worker sent no answer.');
            if (!response.ok) throw new Error(response.error);
            showToast(`Queued ${response.count} image${response.count === 1 ? '' : 's'}.`);
        } catch (cause) {
            showToast(`Could not queue the batch: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
    };

    function onMove(event: MouseEvent): void {
        if (isBatchUi(event.target as Element)) {
            placeHover(null);
            return;
        }
        const hit = findAt(document, event.clientX, event.clientY, 0, 0);
        placeHover(hit && hit !== 'blocked-frame' ? hit.rect : null);
    }

    function onClick(event: MouseEvent): void {
        if (isBatchUi(event.target as Element)) return;
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

        const existing = selection.findIndex((item) =>
            item.element === hit.element
            || (item.url === hit.url && Math.abs(item.rect.top - hit.rect.top) < 1
                && Math.abs(item.rect.left - hit.rect.left) < 1));
        if (existing >= 0) {
            selection[existing].element.removeAttribute(OVERLAY_TARGET_ATTRIBUTE);
            selection.splice(existing, 1);
            redrawMarks();
            return;
        }

        const token = `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        hit.element.setAttribute(OVERLAY_TARGET_ATTRIBUTE, token);
        selection.push({ token, url: hit.url, element: hit.element, rect: hit.rect });
        makeBar();
        redrawMarks();
    }

    function onKey(event: KeyboardEvent): void {
        if (event.key === 'Escape') finish(false);
    }

    shield.addEventListener('click', onClick);
    window.addEventListener('click', onClick, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', redrawMarks, true);
    window.addEventListener('resize', redrawMarks);
    for (const type of PAGE_EVENTS) window.addEventListener(type, swallowPageEvent, true);
    makeBar();
    redrawMarks();
    showToast('Selection mode: click images to select, then use the tick bar. Escape cancels.');
}

// The same bundle is injected for the overlay, so the popup starts the picker
// explicitly through this handle; importing the bundle must not open pick mode.
const pickerScope = window as unknown as {
    __comicTranslatorPicker?: { start: () => void; startSelection: () => void };
};
pickerScope.__comicTranslatorPicker = {
    start: () => {
        if (window.__comicTranslatorPickerActive) return;
        window.__comicTranslatorPickerActive = true;
        document.documentElement.setAttribute(PICKING_ATTR, 'true');
        start();
    },
    startSelection: () => {
        if (window.__comicTranslatorPickerActive) return;
        startBatchSelection();
    },
};

type BatchProgressUi = {
    element: HTMLElement;
    text: HTMLElement;
    cancel: HTMLButtonElement;
    hideTimer?: number;
};

let batchProgressUi: BatchProgressUi | null = null;

function updateBatchProgress(state: BatchState): void {
    if (!batchProgressUi) {
        const element = document.createElement('div');
        element.setAttribute('data-comic-translator-batch-progress', 'true');
        element.style.position = 'fixed';
        element.style.right = '18px';
        element.style.bottom = '18px';
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
    if (state.status === 'done') {
        ui.text.textContent = `Batch done: ${done}/${total}${failed ? `, ${failed} failed` : ''}`;
        ui.cancel.style.display = 'none';
        window.clearTimeout(ui.hideTimer);
        ui.hideTimer = window.setTimeout(() => {
            ui.element.remove();
            batchProgressUi = null;
        }, 6000);
    } else if (state.status === 'cancelled') {
        ui.text.textContent = `Batch cancelled: ${done}/${total}`;
        ui.cancel.style.display = 'none';
        window.clearTimeout(ui.hideTimer);
        ui.hideTimer = window.setTimeout(() => {
            ui.element.remove();
            batchProgressUi = null;
        }, 4000);
    } else {
        ui.cancel.style.display = '';
        ui.text.textContent = running >= 0
            ? `Translating ${running + 1}/${total}...`
            : `Queued ${total} images...`;
        ui.cancel.onclick = () => {
            ui.cancel.disabled = true;
            void chrome.runtime.sendMessage(serviceWorkerRequestFactory.ofCancel(state.id)).catch(() => undefined);
        };
    }
}

const batchWindow = window as unknown as { __comicTranslatorBatchListener?: boolean };
if (!batchWindow.__comicTranslatorBatchListener) {
    batchWindow.__comicTranslatorBatchListener = true;
    chrome.runtime.onMessage.addListener((message: unknown) => {
        const progress = message as BatchProgressMessage | undefined;
        if (!progress || progress.type !== 'batch-progress') return false;
        updateBatchProgress(progress.state);
        return false;
    });
}

export { };
