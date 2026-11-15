/**
  * The page-side half of the translation switch. The popup sends this exact
  * function to the page, so the switch changes the overlay the same way the
  * picker menu does.
  *
  * Kept self-contained on purpose: chrome.scripting.executeScript serialises
  * the function, so it may only use its arguments and browser globals.
  */
export function setOverlayOpacityInPage(opacity: number): number {
    const api = (globalThis as unknown as {
        __comicTranslatorOverlay?: { setOpacity: (value: number) => number };
    }).__comicTranslatorOverlay;
    return api?.setOpacity(opacity) ?? 0;
}
