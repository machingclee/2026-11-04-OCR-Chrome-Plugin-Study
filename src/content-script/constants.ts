/**
 * Constants used only by the injected picker. Values that another bundle also
 * reads stay in src/shared/constants.ts.
 */

/** DOM ids owned by the injected picker. */
export const SHIELD_ID = 'comic-translator-shield';
export const HIGHLIGHT_ID = 'comic-translator-highlight';
export const TOAST_ID = 'comic-translator-toast';
export const BATCH_BAR_ID = 'comic-translator-batch-bar';
export const BATCH_MARK_ATTR = 'data-comic-translator-mark';

/** Extensions a background-image URL must end in to count as an image. */
export const IMAGE_URL_PATTERN = /\.(avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#]|$)/i;
