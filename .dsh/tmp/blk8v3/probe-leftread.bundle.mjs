// scripts/harness/env.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
var ROOT = process.cwd();
var candidates = [
  process.env.CANVAS_ROOT,
  `${ROOT}/node_modules`,
  "/Users/chingcheonglee/Repos/Javascript/ShinobuTranslator/node_modules"
].filter((value) => typeof value === "string" && value.length > 0);
var canvasModule = null;
var tried = [];
for (const directory of candidates) {
  try {
    canvasModule = createRequire(`${directory}/package.json`)("canvas");
    break;
  } catch (cause) {
    tried.push(`${directory}: ${cause instanceof Error ? cause.code ?? cause.message : String(cause)}`);
  }
}
if (!canvasModule) {
  throw new Error([
    "No canvas implementation found, so the pipeline cannot render in Node.",
    "Install one with `npm install --no-save canvas`, or point CANVAS_ROOT at a",
    "checkout whose node_modules holds it. Tried:",
    ...tried.map((line) => `  ${line}`)
  ].join("\n"));
}
var { createCanvas, loadImage } = canvasModule;
globalThis.OffscreenCanvas = class OffscreenCanvasShim {
  constructor(width, height) {
    return createCanvas(width, height);
  }
};
globalThis.document = {
  createElement: (tag) => {
    if (tag !== "canvas") throw new Error(`The page harness only creates canvases, not <${tag}>.`);
    return createCanvas(1, 1);
  }
};
if (typeof globalThis.ImageData === "undefined" && canvasModule.ImageData) {
  globalThis.ImageData = canvasModule.ImageData;
}
globalThis.createImageBitmap = async (blob) => loadImage(Buffer.from(await blob.arrayBuffer()));
globalThis.chrome = {
  runtime: {
    getURL: (path) => `${ROOT}/public/${path}`
  }
};
var realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (typeof url === "string" && url.startsWith("/")) {
    return new Response(readFileSync(url), {
      status: 200,
      headers: { "content-type": "application/octet-stream" }
    });
  }
  return realFetch(input, init);
};
async function prepareOrt() {
  const [{ default: ort2 }, webgpu2] = await Promise.all([
    import("onnxruntime-web"),
    import("onnxruntime-web/webgpu")
  ]);
  for (const instance of [ort2, webgpu2]) {
    instance.env.wasm.numThreads = 1;
    instance.env.wasm.proxy = false;
    instance.env.wasm.wasmPaths = `${ROOT}/node_modules/onnxruntime-web/dist/`;
  }
  return ort2;
}
function readApiKey() {
  const fromEnvironment = process.env.DEEPSEEK_API_KEY ?? process.env.VITE_DEEPSEEK_API_KEY;
  if (fromEnvironment && fromEnvironment.trim().length > 0) return fromEnvironment.trim();
  try {
    const text = readFileSync(`${ROOT}/.env`, "utf8");
    const value = text.match(/^\s*(?:VITE_)?DEEPSEEK_API_KEY\s*=\s*(.*)$/m)?.[1]?.trim() ?? "";
    return value.replace(/^['"]|['"]$/g, "");
  } catch {
    return "";
  }
}

// src/lib/ocr/recognize.ts
import * as ort from "onnxruntime-web/webgpu";
var webgpu = typeof navigator !== "undefined" && "gpu" in navigator;

// src/lib/ocr/cloudOcr.ts
var REQUEST_TIMEOUT_MS = 6e4;
var DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
var DEEPSEEK_MODEL = "deepseek-flash";
var TRANSCRIBE_PROMPT = [
  "The image is a crop of a Japanese comic, shown in the orientation it has on the page.",
  "A crop usually holds one text line. Vertical Japanese reads top to bottom with the columns running right to left; horizontal Japanese reads left to right, top to bottom.",
  "A crop can hold several parallel text lines when one detection box covered more than one column. Report each one separately, in reading order.",
  "Transcribe the text exactly as printed.",
  "Keep small kana (\u3063 \u3083 \u3085 \u3087 \u3041 \u3043 \u3045 \u3047 \u3049 \u30FC), dakuten and handakuten, punctuation (\u3001\u3002\u300C\u300D\u300E\u300F\u2026\uFF01\uFF1F), Latin letters, digits and symbols.",
  "Do not translate, do not explain, do not add spaces, and do not convert full-width characters to half-width or the reverse.",
  "Never complete a word from context: transcribe only the glyphs that are visible.",
  "row is the 1-based position of the line in reading order. columns is the number of parallel character columns that line itself holds, which is 1 for a normal line.",
  'Return JSON only: {"lines":[{"row":1,"columns":1,"text":"\u2026"}]}'
].join(" ");
function thinkingOf(effort) {
  if (effort === "off") return { thinking: { type: "disabled" } };
  return { thinking: { type: "enabled" }, reasoning_effort: effort };
}
function deepSeekBody(dataUrls, prompt, effort) {
  const content = [{ type: "text", text: prompt }];
  dataUrls.forEach((dataUrl) => {
    content.push({ type: "image_url", image_url: { url: dataUrl } });
  });
  return {
    model: DEEPSEEK_MODEL,
    // One call does the transcription, the layout and the translation, so it
    // gets the effort the translation needs. Reading glyphs alone would not
    // justify a chain of thought; deciding the columns, the type and the
    // Chinese wording in the same pass does.
    ...thinkingOf(effort),
    messages: [
      { role: "system", content: "You read Japanese comic pages: you transcribe the text and describe where each line sits. You never translate; a separate request does that." },
      { role: "user", content }
    ]
  };
}
async function post(url, headers, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body)
    });
  } catch (cause) {
    if (controller.signal.aborted) throw new Error("The cloud reader did not answer within a minute.");
    throw cause;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(`The cloud reader answered ${response.status}. ${detail.slice(0, 160)}`);
    error.status = response.status;
    throw error;
  }
  return response.text();
}
function extractJson(content) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return content.trim();
  return content.slice(start, end + 1).trim();
}
function assertImagesRead(tokens, images, provider) {
  if (typeof tokens !== "number" || tokens <= 0 || images === 0) return;
  const floor = 250 + images * 80;
  console.info(`[cloud-ocr] ${provider}: ${images} crops, ${tokens} input tokens (floor ${floor})`);
  if (tokens < floor) {
    throw new Error(
      `The ${provider} model answered with ${tokens} input tokens for ${images} crops, so it never read the images.`
    );
  }
}
function readReadings(content) {
  const parsed = JSON.parse(extractJson(content));
  const list = parsed.lines ?? parsed.results;
  if (!Array.isArray(list)) {
    const plain = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (plain.length === 0) throw new Error("The cloud reader returned no lines array.");
    return [{ row: 1, columns: 1, text: plain }];
  }
  const readings = [];
  for (const item of list) {
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (text.length === 0) continue;
    const row = Number(item.row);
    const columns = Number(item.columns);
    readings.push({
      row: Number.isInteger(row) && row > 0 ? row : readings.length + 1,
      columns: Number.isFinite(columns) && columns >= 1 ? Math.round(columns) : 1,
      text
    });
  }
  return readings.sort((left, right) => left.row - right.row).slice(0, 4);
}
function deepSeekContent(payload) {
  const body = payload;
  return body.choices?.[0]?.message?.content ?? "";
}
function deepSeekInputTokens(payload) {
  const body = payload;
  return body.usage?.prompt_tokens;
}
async function deepSeekContentForSync(key2, dataUrls, prompt, effort) {
  const raw = await post(DEEPSEEK_ENDPOINT, { Authorization: `Bearer ${key2}` }, deepSeekBody(dataUrls, prompt, effort));
  const payload = JSON.parse(raw);
  assertImagesRead(deepSeekInputTokens(payload), dataUrls.length, "deepseek");
  const usage = payload.usage;
  console.info(`[read] deepseek effort ${effort}, tokens ${usage?.completion_tokens ?? "?"}, reasoning ${usage?.completion_tokens_details?.reasoning_tokens ?? 0}`);
  return deepSeekContent(payload);
}
var READ_EFFORT = "off";
async function requestDeepSeek(key2, dataUrls, effort = READ_EFFORT) {
  return readReadings(await deepSeekContentForSync(key2, dataUrls, TRANSCRIBE_PROMPT, effort));
}
var REGION_EXAMPLE = {
  text: "\u2026",
  type: "chat",
  direction: "v",
  // How far the line leans, clockwise from upright, and the size of one
  // character in page pixels. Both are required: a leaned line drawn upright
  // is the one thing the reader cannot leave to a box edge.
  lean: 0,
  em: 24,
  // The number printed on the blue rectangle that holds the line. The page
  // box follows, for a crop whose numbers cannot be read.
  box: 2,
  x: 268,
  y: 412,
  width: 27,
  height: 162
};
var BLOCK_EXAMPLE = { regions: [REGION_EXAMPLE] };
var BLOCK_PROMPT = [
  "The image is a crop of one region of a Japanese comic page: a speech balloon, a caption, or a sound effect.",
  "Report one entry per text line, in reading order. A vertical column is one entry, a horizontal row is one entry. Never merge two columns or two rows into one entry, even when they form one sentence: each entry carries only the characters printed in its own column.",
  "One entry is one run of characters printed at one size. If a block mixes sizes, split it by size, not by row: a name box printed as a small \u4FEE\u58EB1\u5E74 followed by a large \u6709\u7559\u6728 \u5186 is two entries, each with its own box, and a large heading above a small caption is two entries for the same reason.",
  "Furigana is not text. The small kana printed beside or above kanji to show how it is read are never an entry, never part of text, never a box, and never a field of their own. The test is size: furigana characters are clearly smaller than the characters of the line they belong to, so a small column sitting inside or beside a large column is a reading, and the entry is the large characters only.",
  "Blue rectangles mark the text of this block, as the detector found it. Text inside a blue rectangle is the only text to read: report those lines. Anything outside every blue rectangle is artwork or handwriting, so it is not a line, never goes into text, and never has an entry of its own. A formula, a scribbled number, an arrow or a signature drawn by hand is ignored completely, even when it runs beside a column or through the gap between columns. A column stays inside its own blue rectangle.",
  "text: exactly as printed, with small kana, dakuten, punctuation, Latin letters and digits. Never complete a word from context.",
  "Do not translate: this answer is read only. A separate request translates the text once the whole block has been read.",
  "A grid is drawn over the image and every line of it carries its page coordinate: thin lines mark single cells, a thicker line marks every fifth. The numbers along the top edge are blue and are the x of that line in page pixels; the numbers along the left edge are red and are its y. They are absolute page pixels, not a count: a line printed 1035 is x 1035 on the page, wherever the crop starts. A small grey number beside every fifth coordinate is the cell index, which you do not need.",
  "A reading can sit inside a blue rectangle, in the gap between the large characters and the box edge. It is still not a line: the entry covers the large characters, its box stays on the large characters, and the reading is left out of text. Never report it in any field. Small kana that belong to the word itself, such as the \u3063 in \u3044\u3063\u3066, are part of the word and stay.",
  'type: "chat" for dialogue, including a short \u306F\u3044, \u3046\u3093, \u3048\u3048, \u305D\u3046, \u3042\u3042, \u3044\u3048, \u3044\u3084 and a line that starts with an ellipsis. "name" for a box that holds a name, a title, a place name or a label and no sentence: \u6709\u7559\u6728 \u74B0 is a name, and so is a lone \u5186 printed with its reading \u3064\u3076\u3089 beside it. "sfx" for onomatopoeia and sound effects such as \u30C9\u30C9\u30C9, \u30B4\u30B4\u30B4, \u30B6\u30EF\u30B6\u30EF, \u30C9\u30F3, \u30D0\u30F3, \u30AC\u30B7\u30E3.',
  'direction: "v" when the line reads top to bottom, "h" when it reads left to right. A leaned line is still "v" or "h": do not use another letter for it.',
  "lean: for a leaned line, how far it is rotated clockwise from upright, in degrees between -45 and 45. A vertical line is upright when it runs straight down; if the bottom of the column leans left, lean is positive (for example 12). A horizontal line is upright when it runs left to right; if its right end rises, lean is negative. Every entry must carry lean; give 0 when the line is upright.",
  "em: the size of one character in page pixels, measured across the glyph itself (its width and height are about equal), not the gap between columns and not the whole box. Read it from the grid lines. Every entry must carry em, even when the line is upright.",
  "angle: the old name for lean, kept only for a horizontal line measured from the horizontal axis. Prefer lean; do not send both.",
  "box: the number printed in green at the top left corner of the blue rectangle that holds this line. This is the position that matters: the rectangle is where the ink is, so naming it is exact. If one entry covers more than one rectangle, give their numbers in reading order, as an array, e.g. [3,2].",
  "x and y: only when no number is visible. The page pixel of the top left corner of the line, read from the numbers on the grid: an edge a few pixels past the line printed 1035 is 1037, and one a few pixels above the line printed 140 is 137. width and height: the size of the box in page pixels, from the same numbers.",
  "The box is tight around that line. For a vertical line width is the width of one character and height runs from the top of the first character to the bottom of the last; for a horizontal line height is one character and width is the length of the run. A character is about as many pixels across as it is down, so six characters of a 27 pixel character are about 162 pixels tall. Measure the character you see, not the gap between two grid lines.",
  "Do not round a corner to a grid line and do not count cells: answer with the pixels the number reads, so a character whose left edge is a few pixels past the line printed 1034 has x 1037. x, y, width and height are whole pixels. When an edge is cut off by the crop, still give the page pixel of the visible ink.",
  `The numbers in the example show the shape of the answer, not this crop. Skip artwork with no text. Return JSON only: ${JSON.stringify(BLOCK_EXAMPLE)}`
].join(" ");

// .dsh/tmp/blk8v3/probe-leftread.mjs
await prepareOrt();
var img = await loadImage("fixtures/page-forty.jpg");
var key = readApiKey();
for (const box of [
  { x: 282, y: 595, w: 34, h: 147 },
  { x: 285, y: 600, w: 30, h: 140 },
  { x: 278, y: 590, w: 40, h: 155 }
]) {
  const scale = 4;
  const c = createCanvas(box.w * scale, box.h * scale);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
  const url = c.toDataURL("image/jpeg", 0.92);
  const lines = await requestDeepSeek(key, [url], "off");
  console.log(JSON.stringify(box), "->", JSON.stringify(lines.map((l) => l.text)));
}
