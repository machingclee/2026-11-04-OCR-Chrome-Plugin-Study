import { OVERLAY_TARGET_ATTRIBUTE } from '../shared/constants';
import type { OverlayItem, OverlayRequest, OverlayResponse } from '../shared/types';

const WRAPPER_ATTR = 'data-comic-translator-wrapper';
const LAYER_ATTR = 'data-comic-translator-layer';
const BOX_ATTR = 'data-comic-translator-box';
const INCLINED_ATTR = 'data-comic-translator-inclined';
const INPAINT_ATTR = 'data-comic-translator-inpaint';
const TEXT_ATTR = 'data-comic-translator-text';
const IMAGE_STYLE_ATTR = 'data-comic-translator-image-style';
const POSITION_ATTR = 'data-comic-translator-position';
const OPACITY_ATTR = 'data-comic-translator-overlay-opacity';

const stopWatchers = new Map<HTMLElement, () => void>();

/** Translated glyphs sit a little under the measured source size. */
const TRANSLATED_FONT_SCALE = 0.9;

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

    // A pick captured as pixels has no URL to match, only the token above.
    if (!request.imageUrl) return null;

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
    if (Math.abs(item.angle ?? 0) >= 0.01) {
        style.background = item.background ?? '#ffffff';
        style.backgroundImage = 'none';
        style.clipPath = '';
        style.transform = `rotate(${item.angle}rad)`;
        style.transformOrigin = 'center';
    }
    patch.dataset.comicTranslatorPatch = 'true';
    void request;
    void scale;
    return patch;
}

/**
 * Every label is one column or one row, so the reader nudges a single line and
 * leaves the rest of the balloon where it is. The move is a transform, so the
 * percentage layout still owns the base position, and a leaned label keeps its
 * rotation. Labels stay inside the image, because the layer clips them there.
 */
function enableItemDrag(box: HTMLElement, angle: number): void {
    const inclined = Math.abs(angle) >= 0.01;
    let offsetX = 0;
    let offsetY = 0;

    const paint = (): void => {
        const rotation = inclined ? ` rotate(${angle}rad)` : '';
        box.style.transform = `translate(${offsetX}px, ${offsetY}px)${rotation}`;
    };

    box.style.pointerEvents = 'auto';
    box.style.cursor = 'grab';
    box.style.touchAction = 'none';
    box.style.userSelect = 'none';
    box.title = 'Drag to move this label';

    box.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const layer = box.closest<HTMLElement>(`[${LAYER_ATTR}]`);
        if (!layer) return;
        event.preventDefault();
        event.stopPropagation();

        const startX = event.clientX;
        const startY = event.clientY;
        const baseX = offsetX;
        const baseY = offsetY;
        // Clamp against the label as it sits now, without the offset this drag
        // already applied, so a second drag does not drift towards the edge.
        const area = layer.getBoundingClientRect();
        const rect = box.getBoundingClientRect();
        const originLeft = rect.left - baseX;
        const originTop = rect.top - baseY;
        const minX = Math.min(0, area.left - originLeft);
        const maxX = Math.max(0, area.right - (originLeft + rect.width));
        const minY = Math.min(0, area.top - originTop);
        const maxY = Math.max(0, area.bottom - (originTop + rect.height));
        let moved = false;
        box.style.cursor = 'grabbing';
        box.style.zIndex = '5';

        const move = (moveEvent: PointerEvent): void => {
            if (moveEvent.pointerId !== event.pointerId) return;
            if (!moved && (Math.abs(moveEvent.clientX - startX) > 3 || Math.abs(moveEvent.clientY - startY) > 3)) {
                moved = true;
            }
            offsetX = Math.min(Math.max(baseX + (moveEvent.clientX - startX), minX), maxX);
            offsetY = Math.min(Math.max(baseY + (moveEvent.clientY - startY), minY), maxY);
            paint();
        };
        const end = (cancelled: boolean): void => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', release);
            document.removeEventListener('pointercancel', cancel);
            box.style.cursor = 'grab';
            box.style.zIndex = '2';
            if (cancelled || !moved) return;
            // The pointer leaves the label on a long drag, so the follow-up
            // click lands on whatever sits under it. That click belongs to the
            // drag, not to the page's link or lightbox.
            const swallow = (clickEvent: MouseEvent): void => {
                clickEvent.preventDefault();
                clickEvent.stopPropagation();
            };
            document.addEventListener('click', swallow, true);
            window.setTimeout(() => document.removeEventListener('click', swallow, true), 300);
        };
        const release = (): void => end(false);
        const cancel = (): void => end(true);
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', release);
        document.addEventListener('pointercancel', cancel);
    });

    // A drag that ends on a label must not follow a link or open a lightbox
    // that sits under the overlay.
    box.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
}

/** White halo around the glyphs. Stroke is centered, so twice the 3.5% radius stays outside the fill. */
function applyWhiteStroke(box: HTMLElement, fontSize: number): void {
    const width = Math.max(1, Math.round(fontSize * 0.07));
    box.style.setProperty('-webkit-text-stroke', `${width}px #ffffff`);
    box.style.setProperty('paint-order', 'stroke fill');
}

function makeBox(
    item: OverlayItem,
    request: OverlayRequest,
    width: number,
    height: number,
    scale: number,
): HTMLElement {
    const box = document.createElement('span');
    box.setAttribute(BOX_ATTR, 'true');
    box.setAttribute('data-comic-translator-label', 'true');
    if (item.groupId !== undefined) box.setAttribute('data-comic-translator-group', String(item.groupId));
    const inclined = Math.abs(item.angle ?? 0) >= 0.01;
    if (inclined) box.setAttribute(INCLINED_ATTR, 'true');
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
    // In vertical-rl the inline axis runs down the column, so center pulls
    // the glyphs off the top. Horizontal text still centres on its own axis.
    style.textAlign = item.vertical ? 'start' : 'center';
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
    style.lineHeight = '1';
    style.letterSpacing = '0';
    style.wordSpacing = '0';
    style.whiteSpace = 'pre-wrap';
    style.wordBreak = 'break-word';
    // enableItemDrag owns pointer events: only the label itself is a target.
    style.pointerEvents = 'none';
    style.zIndex = '2';
    if (inclined) {
        style.transform = `rotate(${item.angle}rad)`;
        style.transformOrigin = 'center';
    }

    if (item.vertical) {
        // A flex container swaps its axes in vertical writing mode, which can
        // leave a short column at the left edge. A grid centres the text on both
        // axes, so a lone vertical ellipsis sits in the middle of its balloon.
        style.writingMode = 'vertical-rl';
        // mixed rotates U+22EE back into horizontal dots. toVertical emits
        // U+FE19, whose dots already sit in the centre of the em box.
        style.textOrientation = 'upright';
        style.display = 'grid';
        // Vertical writing swaps the grid axes: align centre across the
        // column, but start at the top so short columns do not float down.
        style.placeItems = 'center start';
        // Let the text use the number of columns the balloon has room for.
        // The word joiner in toVertical keeps a trailing ellipsis with the
        // preceding glyph instead of forcing the whole label into one column.
        style.whiteSpace = 'pre-wrap';
        style.lineBreak = 'strict';
    }

    const boxWidth = Math.max(1, item.width * scale);
    const boxHeight = Math.max(1, item.height * scale);
    // Match the source comic's glyph size. The group box can span several
    // columns, so its height is not a font size; the offscreen pass measures the
    // original line thickness instead.
    const sourceSize = item.fontSize && item.fontSize > 0 ? item.fontSize * scale : 0;
    const fallback = Math.min(boxHeight * 0.8, boxWidth * 0.9);
    const size = Math.max(7, (sourceSize > 0 ? sourceSize : fallback) * TRANSLATED_FONT_SCALE);
    box.style.fontSize = `${size}px`;
    applyWhiteStroke(box, size);
    box.dataset.comicTranslatorSourceSize = String(size);
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
    if (box.hasAttribute(INCLINED_ATTR)) {
        const boxRect = box.getBoundingClientRect();
        return rect.width <= boxRect.width + 1 && rect.height <= boxRect.height + 1;
    }
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
    const groups = new Map<string, HTMLElement[]>();
    let solo = 0;
    for (const box of layer.querySelectorAll<HTMLElement>(`[${BOX_ATTR}]`)) {
        const key = box.getAttribute('data-comic-translator-group') ?? `solo-${solo++}`;
        const list = groups.get(key);
        if (list) list.push(box);
        else groups.set(key, [box]);
    }

    for (const boxes of groups.values()) {
        const source = Number.parseFloat(boxes[0].style.fontSize) || 12;
        // Fit the translation inside the detected box. The group keeps one
        // shared size, and the floor prevents an unreadable collapse.
        const floor = Math.max(7, Math.round(source * 0.7));
        let size = source;
        while (size > floor && boxes.some((box) => !textFits(box) || !estimatedFits(box, size, leading))) {
            size -= 1;
        }
        for (const box of boxes) {
            box.style.fontSize = `${size}px`;
            applyWhiteStroke(box, size);
        }
    }
}

function ensureBoxStyle(): void {
    const css = [
        `span[${BOX_ATTR}="true"]:not([${INCLINED_ATTR}]) { overflow: visible !important; height: unset !important; padding-top: 0px !important; }`,
        // The switch hides the whole layer with opacity. An invisible label must
        // not keep swallowing drags that belong to the original page.
        `html[${OPACITY_ATTR}="0"] span[${BOX_ATTR}="true"] { pointer-events: none !important; }`,
    ].join('\n');
    const existing = document.getElementById('comic-translator-box-style');
    if (existing) {
        existing.textContent = css;
        return;
    }
    const style = document.createElement('style');
    style.id = 'comic-translator-box-style';
    style.textContent = css;
    document.head.appendChild(style);
}

function apply(request: OverlayRequest): OverlayResponse {
    ensureBoxStyle();
    const target = findTarget(request);
    if (!target) {
        return { ok: false, error: 'The picked image is no longer on this page.' };
    }
    clearTarget(target);

    // An earlier build replaced the image source with the erased PNG. A rebuilt
    // extension does not replace an already injected content script, so restore
    // the real page source here before adding the new layer.
    if (target instanceof HTMLImageElement
        && request.imageUrl
        && !request.imageUrl.startsWith('data:')
        && target.currentSrc.startsWith('data:')) {
        target.removeAttribute('srcset');
        target.src = request.imageUrl;
    }
    target.style.visibility = 'visible';
    target.style.opacity = '1';

    const width = request.width > 0 ? request.width : target.clientWidth;
    const height = request.height > 0 ? request.height : target.clientHeight;
    if (width <= 0 || height <= 0) {
        return { ok: false, error: 'The picked image has no measured size.' };
    }

    const layer = target instanceof HTMLImageElement ? wrapImage(target) : attachLayer(target);
    layer.style.background = 'transparent';
    layer.style.mixBlendMode = 'normal';
    layer.style.opacity = document.documentElement.getAttribute(OPACITY_ATTR) === '0' ? '0' : '1';
    const host = layer.parentElement;
    const renderedWidth = host?.getBoundingClientRect().width ?? width;
    const scale = renderedWidth / width;

    // Two sibling layers keep every inpainted pixel under every translated
    // glyph. Group containers are stacking contexts, so a patch inside a later
    // group used to paint over the text of an earlier one.
    const inpaintLayer = document.createElement('div');
    inpaintLayer.setAttribute(INPAINT_ATTR, 'true');
    inpaintLayer.style.position = 'absolute';
    inpaintLayer.style.inset = '0';
    inpaintLayer.style.overflow = 'hidden';
    inpaintLayer.style.pointerEvents = 'none';
    inpaintLayer.style.zIndex = '1';
    layer.appendChild(inpaintLayer);

    const textLayer = document.createElement('div');
    textLayer.setAttribute(TEXT_ATTR, 'true');
    textLayer.style.position = 'absolute';
    textLayer.style.inset = '0';
    textLayer.style.overflow = 'visible';
    textLayer.style.pointerEvents = 'none';
    textLayer.style.zIndex = '2';
    layer.appendChild(textLayer);

    if (request.erasedUrl) {
        const erased = document.createElement('img');
        erased.src = request.erasedUrl;
        erased.alt = '';
        erased.style.position = 'absolute';
        erased.style.inset = '0';
        erased.style.width = '100%';
        erased.style.height = '100%';
        erased.style.objectFit = 'fill';
        erased.style.pointerEvents = 'none';
        erased.style.background = 'transparent';
        erased.style.mixBlendMode = 'normal';
        erased.style.zIndex = '1';
        erased.setAttribute('data-comic-translator-erased', 'true');
        inpaintLayer.appendChild(erased);
    }

    let count = 0;
    const grouped = new Map<number, typeof request.items>();
    request.items.forEach((item, index) => {
        const key = item.groupId ?? -1_000_000 - index;
        const list = grouped.get(key);
        if (list) list.push(item);
        else grouped.set(key, [item]);
    });

    for (const items of grouped.values()) {
        const group = document.createElement('div');
        group.setAttribute('data-comic-translator-group-container', 'true');
        group.style.position = 'absolute';
        group.style.inset = '0';
        group.style.overflow = 'visible';
        // The group is only a layout and fitting bucket. It must stay
        // transparent to the pointer engine, otherwise it swallows the whole
        // image; each label below it accepts its own drag.
        group.style.pointerEvents = 'none';
        textLayer.appendChild(group);
        for (const item of items) {
            const patch = makePatch(item, request, width, height, scale);
            if (patch) inpaintLayer.appendChild(patch);
            const box = makeBox(item, request, width, height, scale);
            enableItemDrag(box, item.angle ?? 0);
            group.appendChild(box);
            count += 1;
        }
    }

    fitBoxes(layer, 1);
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
 * Show or hide every translated layer at once. The erased base image lives in
 * the same layer, so opacity 0 puts the untouched original page back in view.
 */
function setOpacity(value: number): number {
    const opacity = value > 0 ? 1 : 0;
    document.documentElement.setAttribute(OPACITY_ATTR, String(opacity));
    const layers = document.querySelectorAll<HTMLElement>(`[${LAYER_ATTR}]`);
    for (const layer of layers) layer.style.opacity = String(opacity);
    return layers.length;
}

/**
 * The picker's menu asks two questions about this document: does it carry a
 * translation at all, and is that translation currently on screen. The layer
 * holds the answer, because apply() and setOpacity() both write its opacity.
 */
export function readOverlayState(): { present: boolean; visible: boolean } {
    const layers = [...document.querySelectorAll<HTMLElement>(`[${LAYER_ATTR}]`)];
    return {
        present: layers.length > 0,
        visible: layers.some((layer) => layer.style.opacity !== '0'),
    };
}

/** Flip every layer here; null means this document had nothing to flip. */
export function toggleOverlayVisibility(): boolean | null {
    const state = readOverlayState();
    if (!state.present) return null;
    const next = !state.visible;
    setOpacity(next ? 1 : 0);
    return next;
}

/**
 * The popup calls these through chrome.scripting.executeScript, so the result
 * comes back per frame and the popup knows whether the image was found.
 */
const api = {
    apply,
    clear: clearAll,
    setOpacity,
};

type OverlayApi = typeof api;

const scope = window as unknown as { __comicTranslatorOverlay?: OverlayApi };
scope.__comicTranslatorOverlay = api;

export { apply, clearAll };
