import { OVERLAY_TARGET_ATTRIBUTE } from '../shared/constants';
import type { OverlayItem, OverlayRequest, OverlayResponse } from '../shared/types';

const WRAPPER_ATTR = 'data-comic-translator-wrapper';
const LAYER_ATTR = 'data-comic-translator-layer';
const BOX_ATTR = 'data-comic-translator-box';
const IMAGE_STYLE_ATTR = 'data-comic-translator-image-style';
const POSITION_ATTR = 'data-comic-translator-position';

const stopWatchers = new Map<HTMLElement, () => void>();

type ImageStyle = {
    display: string;
    width: string;
    height: string;
    margin: string;
    position: string;
    left: string;
    top: string;
};

function absoluteUrl(value: string): string {
    try {
        return new URL(value, document.baseURI).href;
    } catch {
        return value;
    }
}

function backgroundUrl(element: Element): string {
    const value = getComputedStyle(element).backgroundImage;
    const match = /url\(["']?(.*?)["']?\)/.exec(value);
    return match?.[1] ? absoluteUrl(match[1]) : '';
}

function findTarget(request: OverlayRequest): HTMLElement | null {
    if (request.token) {
        const marked = document.querySelector<HTMLElement>(
            `[${OVERLAY_TARGET_ATTRIBUTE}="${CSS.escape(request.token)}"]`,
        );
        if (marked) return marked;
    }

    const wanted = absoluteUrl(request.imageUrl);
    for (const image of document.images) {
        if (absoluteUrl(image.currentSrc || image.src) === wanted) return image;
    }
    for (const element of document.querySelectorAll<HTMLElement>('div,span,a,i,figure,section')) {
        if (backgroundUrl(element) === wanted) return element;
    }
    return null;
}

function readStyle(image: HTMLImageElement): void {
    const style: ImageStyle = {
        display: image.style.display,
        width: image.style.width,
        height: image.style.height,
        margin: image.style.margin,
        position: image.style.position,
        left: image.style.left,
        top: image.style.top,
    };
    image.setAttribute(IMAGE_STYLE_ATTR, JSON.stringify(style));
}

function restoreStyle(image: HTMLImageElement): void {
    const raw = image.getAttribute(IMAGE_STYLE_ATTR);
    image.removeAttribute(IMAGE_STYLE_ATTR);
    if (!raw) return;
    try {
        const style = JSON.parse(raw) as ImageStyle;
        image.style.display = style.display;
        image.style.width = style.width;
        image.style.height = style.height;
        image.style.margin = style.margin;
        image.style.position = style.position;
        image.style.left = style.left;
        image.style.top = style.top;
    } catch {
        // A malformed marker only costs the restored inline style, not the page.
    }
}

function createLayer(): HTMLElement {
    const layer = document.createElement('div');
    layer.setAttribute(LAYER_ATTR, 'true');
    layer.style.position = 'absolute';
    layer.style.inset = '0';
    layer.style.overflow = 'hidden';
    layer.style.pointerEvents = 'none';
    layer.style.zIndex = '2';
    return layer;
}

/**
 * Put the image in a relatively positioned wrapper that keeps its current
 * on-screen size. Every overlay is a percentage of that wrapper, so it follows
 * whatever size the wrapper ends up with.
 */
function wrapImage(image: HTMLImageElement): HTMLElement {
    const host = image.parentElement instanceof HTMLPictureElement ? image.parentElement : image;
    const rect = host.getBoundingClientRect();
    const computed = getComputedStyle(host);
    const parent = host.parentNode;
    if (!parent) throw new Error('The image is no longer in the page.');

    const wrapper = document.createElement('div');
    wrapper.setAttribute(WRAPPER_ATTR, 'true');
    wrapper.style.position = 'relative';
    wrapper.style.display = 'inline-block';
    wrapper.style.width = `${Math.max(1, rect.width)}px`;
    wrapper.style.height = `${Math.max(1, rect.height)}px`;
    wrapper.style.margin = computed.margin;
    wrapper.style.verticalAlign = computed.verticalAlign === 'baseline' ? 'middle' : computed.verticalAlign;
    wrapper.style.lineHeight = '0';
    wrapper.style.maxWidth = '100%';
    // Keep the wrapper in the same layout slot as the image it replaced.
    wrapper.style.flex = computed.flex;
    wrapper.style.alignSelf = computed.alignSelf;
    wrapper.style.order = computed.order;
    if (computed.float !== 'none') wrapper.style.float = computed.float;

    readStyle(image);
    image.style.display = 'block';
    image.style.width = '100%';
    image.style.height = '100%';
    image.style.margin = '0';
    image.style.position = 'static';

    parent.insertBefore(wrapper, host);
    wrapper.appendChild(host);
    const layer = createLayer();
    wrapper.appendChild(layer);
    return layer;
}

/** A background image has no child to wrap, so its box becomes the container. */
function attachLayer(element: HTMLElement): HTMLElement {
    if (getComputedStyle(element).position === 'static') {
        element.setAttribute(POSITION_ATTR, element.style.position);
        element.style.position = 'relative';
    }
    const layer = createLayer();
    element.appendChild(layer);
    return layer;
}

/**
 * A reader can reuse the same <img> node for the next page. The old labels then
 * sit over the new image because the wrapper and layer belong to the node, not
 * to the page that was translated. Watch the picked node and remove the overlay
 * as soon as the node changes, disappears or gets a different source.
 */
function watchTarget(target: HTMLElement): void {
    stopWatchers.get(target)?.();

    if (target instanceof HTMLImageElement) {
        const src = target.getAttribute('src');
        const srcset = target.getAttribute('srcset');
        const changed = (): void => {
            if (!target.isConnected || target.getAttribute('src') !== src || target.getAttribute('srcset') !== srcset) {
                clearTarget(target);
            }
        };
        const observer = new MutationObserver(changed);
        observer.observe(target, { attributes: true, attributeFilter: ['src', 'srcset'] });
        if (target.parentElement) observer.observe(target.parentElement, { childList: true });
        stopWatchers.set(target, () => {
            observer.disconnect();
            stopWatchers.delete(target);
        });
        return;
    }

    const background = backgroundUrl(target);
    const changed = (): void => {
        if (!target.isConnected || backgroundUrl(target) !== background) clearTarget(target);
    };
    const observer = new MutationObserver(changed);
    observer.observe(target, { attributes: true, attributeFilter: ['style', 'class'] });
    stopWatchers.set(target, () => {
        observer.disconnect();
        stopWatchers.delete(target);
    });
}

/** Remove only the overlay attached to this image, not the rest of a batch. */
function clearTarget(target: HTMLElement): void {
    stopWatchers.get(target)?.();
    stopWatchers.delete(target);

    const wrapper = target.closest<HTMLElement>(`[${WRAPPER_ATTR}]`);
    if (wrapper) {
        const parent = wrapper.parentNode;
        for (const child of [...wrapper.children]) {
            if (child.hasAttribute(LAYER_ATTR)) {
                child.remove();
                continue;
            }
            if (child instanceof HTMLImageElement) restoreStyle(child);
            if (child instanceof HTMLPictureElement) {
                const nested = child.querySelector('img');
                if (nested) restoreStyle(nested);
            }
            parent?.insertBefore(child, wrapper);
        }
        wrapper.remove();
        return;
    }

    for (const layer of target.querySelectorAll<HTMLElement>(`[${LAYER_ATTR}]`)) {
        layer.remove();
    }
    if (target.hasAttribute(POSITION_ATTR)) {
        target.style.position = target.getAttribute(POSITION_ATTR) ?? '';
        target.removeAttribute(POSITION_ATTR);
    }
}

/** Let the reader move a label away from the artwork it is covering. */
function enableDrag(box: HTMLElement): void {
    box.style.pointerEvents = 'auto';
    box.style.cursor = 'grab';
    box.style.userSelect = 'none';
    box.style.touchAction = 'none';
    box.title = 'Drag to move';

    box.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const layer = box.parentElement;
        if (!layer) return;
        event.preventDefault();
        event.stopPropagation();

        const startX = event.clientX;
        const startY = event.clientY;
        const startLeft = Number.parseFloat(box.style.left) || 0;
        const startTop = Number.parseFloat(box.style.top) || 0;
        const width = Number.parseFloat(box.style.width) || 100;
        const height = Number.parseFloat(box.style.height) || 100;
        box.style.cursor = 'grabbing';

        const move = (moveEvent: PointerEvent): void => {
            const rect = layer.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            const dx = ((moveEvent.clientX - startX) / rect.width) * 100;
            const dy = ((moveEvent.clientY - startY) / rect.height) * 100;
            const left = Math.min(Math.max(0, startLeft + dx), Math.max(0, 100 - width));
            const top = Math.min(Math.max(0, startTop + dy), Math.max(0, 100 - height));
            box.style.left = `${left}%`;
            box.style.top = `${top}%`;
        };
        const end = (): void => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', end);
            document.removeEventListener('pointercancel', end);
            box.style.cursor = 'grab';
        };

        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', end);
        document.addEventListener('pointercancel', end);
    });

    // A click after a drag must not follow a link under the label.
    box.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
}

function makePatch(
    item: OverlayItem,
    request: OverlayRequest,
    width: number,
    height: number,
    scale: number,
): HTMLElement | null {
    const area = item.patch;
    if (!area || area.width <= 0 || area.height <= 0) return null;
    const patch = document.createElement('div');
    const style = patch.style;
    style.position = 'absolute';
    style.left = `${(area.x / width) * 100}%`;
    style.top = `${(area.y / height) * 100}%`;
    style.width = `${(area.width / width) * 100}%`;
    style.height = `${(area.height / height) * 100}%`;
    style.boxSizing = 'border-box';
    style.pointerEvents = 'none';
    style.zIndex = '1';
    if (item.clip && item.clip.length >= 3) {
        // The tight text area stays inside the balloon. The solid patch removes
        // every original glyph, and the balloon outline keeps it off the art.
        style.background = item.background ?? '#ffffff';
        const points = item.clip.map((point) => {
            const x = ((point.x - area.x) / area.width) * 100;
            const y = ((point.y - area.y) / area.height) * 100;
            return `${x}% ${y}%`;
        });
        style.clipPath = `polygon(${points.join(', ')})`;
    } else if (item.maskUrl) {
        // No usable outline. Paint the glyph mask instead of a visible square.
        style.backgroundImage = `url("${item.maskUrl}")`;
        style.backgroundRepeat = 'no-repeat';
        style.backgroundSize = '100% 100%';
        style.backgroundColor = 'transparent';
    } else {
        style.background = item.background ?? '#ffffff';
    }
    patch.dataset.comicTranslatorPatch = 'true';
    void request;
    void scale;
    return patch;
}

function makeBox(
    item: OverlayItem,
    request: OverlayRequest,
    width: number,
    height: number,
    scale: number,
): HTMLElement {
    const box = document.createElement('div');
    box.setAttribute(BOX_ATTR, 'true');
    box.textContent = item.text;

    const style = box.style;
    style.position = 'absolute';
    style.left = `${(item.x / width) * 100}%`;
    style.top = `${(item.y / height) * 100}%`;
    style.width = `${(item.width / width) * 100}%`;
    style.height = `${(item.height / height) * 100}%`;
    style.boxSizing = 'border-box';
    style.display = 'flex';
    style.alignItems = 'center';
    style.justifyContent = 'center';
    style.overflow = 'hidden';
    style.padding = '1px 2px';
    style.textAlign = 'center';
    if (item.patch) {
        // The paper patch is its own layer, sized to the detected text area.
        // This box only carries the translated text.
        style.backgroundColor = 'transparent';
        style.backgroundImage = 'none';
    } else if (item.fill) {
        // The tight detected area sits inside the balloon. A solid patch there
        // removes every original glyph, including strokes the seg mask missed.
        // The balloon clip keeps the patch off the artwork outside the balloon.
        style.backgroundColor = item.background ?? '#ffffff';
        style.backgroundImage = 'none';
    } else if (item.maskUrl && item.maskBox) {
        // Paint only the glyph-shaped pixels the seg mask selected. The rest
        // of the box stays transparent, so a loose detection box cannot cover
        // the paper or artwork outside the balloon.
        style.backgroundImage = `url("${item.maskUrl}")`;
        style.backgroundRepeat = 'no-repeat';
        style.backgroundSize = `${item.maskBox.width * scale}px ${item.maskBox.height * scale}px`;
        style.backgroundPosition = `${(item.maskBox.x - item.x) * scale}px ${(item.maskBox.y - item.y) * scale}px`;
        style.backgroundOrigin = 'border-box';
        style.backgroundClip = 'border-box';
        style.backgroundColor = 'transparent';
    } else if (item.rectangle) {
        style.background = item.background ?? '#ffffff';
    } else {
        // Seg said "no ink here": leave the page untouched rather than paint a
        // rectangle that could extend outside the balloon.
        style.backgroundColor = 'transparent';
    }
    style.color = item.color ?? '#111111';
    style.fontFamily = request.fontFamily;
    style.fontWeight = request.weight;
    style.lineHeight = String(request.leading);
    style.whiteSpace = 'pre-wrap';
    style.wordBreak = 'break-word';
    style.pointerEvents = 'none';
    style.zIndex = '2';

    if (item.clip && item.clip.length >= 3 && item.width > 0 && item.height > 0) {
        const points = item.clip.map((point) => {
            const x = ((point.x - item.x) / item.width) * 100;
            const y = ((point.y - item.y) / item.height) * 100;
            return `${x}% ${y}%`;
        });
        style.clipPath = `polygon(${points.join(', ')})`;
    }

    if (item.vertical) {
        // A flex container swaps its axes in vertical writing mode, which can
        // leave a short column at the left edge. A grid centres the text on both
        // axes, so a lone vertical ellipsis sits in the middle of its balloon.
        style.writingMode = 'vertical-rl';
        // mixed rotates the vertical ellipsis back into horizontal dots.
        style.textOrientation = 'upright';
        style.display = 'grid';
        style.placeItems = 'center';
        style.textAlign = 'center';
        // A trailing ellipsis must not start a second column. Let the fit loop
        // shrink instead of wrapping it to the left of the text.
        style.whiteSpace = 'nowrap';
    }

    const boxWidth = Math.max(1, item.width * scale);
    const boxHeight = Math.max(1, item.height * scale);
    // Match the source comic's glyph size. The group box can span several
    // columns, so its height is not a font size; the offscreen pass measures the
    // original line thickness instead.
    const sourceSize = item.fontSize && item.fontSize > 0 ? item.fontSize * scale : 0;
    const fallback = Math.min(boxHeight * 0.8, boxWidth * 0.9);
    const size = Math.max(7, sourceSize > 0 ? sourceSize : fallback);
    box.style.fontSize = `${size}px`;
    enableDrag(box);
    return box;
}

/**
 * Shrink each box until its text fits. scrollWidth and scrollHeight clamp for a
 * centred vertical grid, so measure the text range itself; it keeps the real
 * width and height even when the grid clips the overflow.
 */
function textFits(box: HTMLElement): boolean {
    const range = document.createRange();
    range.selectNodeContents(box);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return true;
    const style = getComputedStyle(box);
    const paddingX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
    const paddingY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    return rect.width <= box.clientWidth - paddingX + 1
        && rect.height <= box.clientHeight - paddingY + 1;
}

function estimatedFits(box: HTMLElement, size: number, leading: number): boolean {
    const text = box.textContent ?? '';
    const characters = [...text].length;
    if (characters === 0) return true;

    const style = getComputedStyle(box);
    const paddingX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
    const paddingY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    const width = box.clientWidth - paddingX;
    const height = box.clientHeight - paddingY;
    if (width <= 0 || height <= 0) return false;

    if (style.writingMode.startsWith('vertical')) {
        const perColumn = Math.max(1, Math.floor(height / size));
        const columns = Math.ceil(characters / perColumn);
        return columns * size * leading <= width + 1;
    }

    const perLine = Math.max(1, Math.floor(width / size));
    const lines = Math.ceil(characters / perLine);
    return lines * size * leading <= height + 1;
}

function fitBoxes(layer: HTMLElement, leading: number): void {
    for (const box of layer.querySelectorAll<HTMLElement>(`[${BOX_ATTR}]`)) {
        let size = Number.parseFloat(box.style.fontSize) || 12;
        while (size > 7 && (!textFits(box) || !estimatedFits(box, size, leading))) {
            size -= 1;
            box.style.fontSize = `${size}px`;
        }
    }
}

function apply(request: OverlayRequest): OverlayResponse {
    const target = findTarget(request);
    if (!target) {
        return { ok: false, error: 'The picked image is no longer on this page.' };
    }
    clearTarget(target);

    const width = request.width > 0 ? request.width : target.clientWidth;
    const height = request.height > 0 ? request.height : target.clientHeight;
    if (width <= 0 || height <= 0) {
        return { ok: false, error: 'The picked image has no measured size.' };
    }

    const layer = target instanceof HTMLImageElement ? wrapImage(target) : attachLayer(target);
    const host = layer.parentElement;
    const renderedWidth = host?.getBoundingClientRect().width ?? width;
    const scale = renderedWidth / width;

    let count = 0;
    for (const item of request.items) {
        if (!item.text.trim() || item.width <= 0 || item.height <= 0) continue;
        const patch = makePatch(item, request, width, height, scale);
        if (patch) layer.appendChild(patch);
        layer.appendChild(makeBox(item, request, width, height, scale));
        count += 1;
    }
    fitBoxes(layer, request.leading);
    watchTarget(target);

    return { ok: true, count };
}

/**
 * Remove every overlay and put each image back where it was. This also cleans up
 * overlays left by an earlier injection of this script.
 */
function clearAll(): void {
    for (const cleanup of [...stopWatchers.values()]) cleanup();
    stopWatchers.clear();

    for (const wrapper of document.querySelectorAll<HTMLElement>(`[${WRAPPER_ATTR}]`)) {
        const parent = wrapper.parentNode;
        for (const child of [...wrapper.children]) {
            if (child.hasAttribute(LAYER_ATTR)) {
                child.remove();
                continue;
            }
            if (child instanceof HTMLImageElement) restoreStyle(child);
            if (child instanceof HTMLPictureElement) {
                const nested = child.querySelector('img');
                if (nested) restoreStyle(nested);
            }
            parent?.insertBefore(child, wrapper);
        }
        wrapper.remove();
    }

    for (const layer of document.querySelectorAll<HTMLElement>(`[${LAYER_ATTR}]`)) {
        const host = layer.parentElement;
        layer.remove();
        if (host?.hasAttribute(POSITION_ATTR)) {
            host.style.position = host.getAttribute(POSITION_ATTR) ?? '';
            host.removeAttribute(POSITION_ATTR);
        }
    }

    document.querySelectorAll(`[${WRAPPER_ATTR}], [${LAYER_ATTR}], [${BOX_ATTR}]`).forEach((node) => {
        node.remove();
    });
}

/**
 * The popup calls these through chrome.scripting.executeScript, so the result
 * comes back per frame and the popup knows whether the image was found.
 */
const api = {
    apply,
    clear: clearAll,
};

type OverlayApi = typeof api;

const scope = window as unknown as { __comicTranslatorOverlay?: OverlayApi };
scope.__comicTranslatorOverlay = api;

export { apply, clearAll };
