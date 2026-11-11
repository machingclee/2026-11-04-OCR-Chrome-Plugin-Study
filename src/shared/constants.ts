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

/** File injected into the page when the user picks an image. */
export const CONTENT_SCRIPT_FILE = 'pickImage.js';

/** Storage key that carries a picked image URL from the content script. */
export const PICKED_IMAGE_URL_KEY = 'pickedImageUrl';

/** Last successful result, readable by the popup after it reopens. */

export const LAST_RESULT_KEY = 'lastDetection';


/** When true, a line outside every block is still kept. */
export const KEEP_OUTSIDE_KEY = 'keepOutside';
/** Stored in the browser only, and sent to DeepSeek by the extension itself. */
export const DEEPSEEK_KEY = 'deepseekKey';
/** The popup asks the page to show its finished image. */
export const REPLACE_IMAGE_MESSAGE = 'comic-translator:replace-image';
/** Gemini wins the tie by default: its free tier needs nothing but a key. */
export const GEMINI_KEY = 'geminiKey';
export const TRANSLATOR_KEY = 'translator';
export const TRANSLATORS = ['gemini', 'deepseek', 'builtin'] as const;
export type TranslatorChoice = (typeof TRANSLATORS)[number];

/** Id of the temporary declarativeNetRequest rule that sets Referer. */
export const REFERER_RULE_ID = 1;

/** Detector model and postprocessing thresholds. */
export const DETECTOR_MODEL_PATH = 'models/comictextdetector.pt.onnx';
export const DETECTOR_INPUT_SIZE = 1024;
export const DETECTOR_SCORE_THRESHOLD = 0.25;
export const DETECTOR_MIN_AREA = 20;
export const DETECTOR_MIN_MEAN_SCORE = 0.5;

/** Japanese recogniser, PP-OCRv6 medium in ONNX, plus its charset. */


export const OCR_MODEL_PATH = 'models/ppocr_v6_medium_rec.onnx';
export const OCR_DICT_PATH = 'models/ppocr_v6_dict.txt';
export const OCR_INPUT_HEIGHT = 48;
export const OCR_INPUT_WIDTH = 320;
export const OCR_NORMALIZE: 'zero_one' | 'minus_one' = 'minus_one';
export const OCR_MIN_CONFIDENCE = 0.4;

/** DBNet widens a shrunken region by area * ratio / perimeter before merging. */
export const DETECTOR_UNCLIP_RATIO = 1.5;
/** Bubble segmentation, a YOLOv8 seg export that finds speech balloons. */
export const BUBBLE_MODEL_PATH = 'models/bubble.onnx';
export const BUBBLE_INPUT_SIZE = 640;
export const BUBBLE_SCORE_THRESHOLD = 0.3;
export const BUBBLE_NMS = 0.45;
export const BUBBLE_MASK_THRESHOLD = 0.5;


