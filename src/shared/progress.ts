/**
 * Detection progress, from the offscreen document to the page.
 *
 * The batch pill only knows the stages the service worker sends, and the worker
 * sends "detecting" once and then nothing until the whole detection returns.
 * That makes a 40-second block reading look like a stuck detector. The
 * offscreen document therefore announces each stage it enters, and the page
 * shows it in the pill.
 */
/** The last stage the page was told about. A repeat is not sent again. */
let announced = '';

/**
 * The part of a stage the pill should show. A model run also reports its
 * milliseconds and which line it is on; those are a new string every call, and
 * several of them in flight make the pill jump between the lines. The pill
 * keeps "recogniser inference" for the whole run.
 */
function stageHeadline(stage: string): string {
    const at = stage.indexOf(' inference');
    if (at < 0) return stage;
    return stage.slice(0, at + ' inference'.length);
}

export function announceStage(stage: string): void {
    const headline = stageHeadline(stage);
    // Only a model run is repeated for every line. The other stages are one
    // each, and the next page says them again, so they are always sent.
    if (headline.endsWith(' inference') && headline === announced) return;
    announced = headline;
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    void chrome.runtime.sendMessage({ kind: 'detect-stage', stage: headline }).catch(() => undefined);
}
