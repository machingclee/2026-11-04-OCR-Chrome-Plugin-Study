/**
  * Constants shared across bundles. Popup, content script, and detector are
  * separate outputs, so a value that two of them depend on must live here and
  * not in a literal on each side.
  */

/** HTML entry points. The Vite build and the runtime must agree on these names. */
export const POPUP_HTML = 'popup.html';
export const OFFSCREEN_HTML = 'offscreen.html';

/** Runtime channel names that every message carries. */
export const SERVICE_WORKER_TARGET = 'service-worker';
export const OFFSCREEN_TARGET = 'offscreen';

/** Storage key that carries a picked image URL from the content script. */
export const PICKED_IMAGE_URL_KEY = 'pickedImageUrl';

/** Last successful result, readable by the popup after it reopens. */
export const LAST_RESULT_KEY = 'lastDetection';

/** Id of the temporary declarativeNetRequest rule that sets Referer. */
export const REFERER_RULE_ID = 1;

/** DOM ids owned by the injected picker. */
export const SHIELD_ID = 'comic-translator-shield';
export const HIGHLIGHT_ID = 'comic-translator-highlight';
export const TOAST_ID = 'comic-translator-toast';

/** Extensions a background-image URL must end in to count as an image. */
export const IMAGE_URL_PATTERN = /\.(avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#]|$)/i;

/** Detector model and postprocessing thresholds. */
export const DETECTOR_MODEL_PATH = 'models/comictextdetector.pt.onnx';
export const DETECTOR_INPUT_SIZE = 1024;
export const DETECTOR_SCORE_THRESHOLD = 0.3;
export const DETECTOR_MIN_AREA = 20;
export const DETECTOR_MIN_MEAN_SCORE = 0.6;
