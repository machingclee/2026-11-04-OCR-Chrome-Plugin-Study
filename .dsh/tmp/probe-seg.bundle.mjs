// .dsh/tmp/probe-seg.mjs
import { writeFileSync } from "node:fs";

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
    ...tried.map((line2) => `  ${line2}`)
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

// src/lib/ocr/recognize.ts
import * as ort from "onnxruntime-web/webgpu";

// src/shared/constants.ts
var OCR_MODEL_PATH = "models/ppocr_v6_medium_rec.onnx";
var OCR_DICT_PATH = "models/ppocr_v6_dict.txt";
var OCR_INPUT_HEIGHT = 48;
var OCR_INPUT_WIDTH = 320;
var OCR_NORMALIZE = "minus_one";

// src/lib/ocr/charset.ts
var charsetPromise = null;
function loadCharset(url) {
  if (!charsetPromise) {
    charsetPromise = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`The charset request failed with ${response.status}.`);
      return response.text();
    }).then((text) => {
      const lines = text.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      return ["", ...lines, " "];
    }).catch((cause) => {
      charsetPromise = null;
      throw cause;
    });
  }
  return charsetPromise;
}

// src/lib/ocr/decode.ts
var BLANK = 0;
function decodeCtc(logits, timeSteps, classes, charset) {
  const tokens = [];
  const kept = [];
  let previous = -1;
  for (let step = 0; step < timeSteps; step += 1) {
    let best = 0;
    let bestScore = logits[step * classes];
    for (let index = 1; index < classes; index += 1) {
      const score = logits[step * classes + index];
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    }
    if (best === BLANK) {
      previous = -1;
      continue;
    }
    if (best === previous) continue;
    tokens.push(best);
    kept.push(bestScore);
    previous = best;
  }
  const text = tokens.map((token) => charset[token] ?? "").join("");
  const confidence = kept.length === 0 ? 0 : Math.exp(kept.reduce((sum, score) => sum + Math.log(Math.max(score, 1e-10)), 0) / kept.length);
  return { text, confidence };
}

// src/lib/warp.ts
function angleOf(box) {
  return box.angle ?? 0;
}
function cropSize(box) {
  const angle = angleOf(box);
  if (Math.abs(angle) < 0.01) {
    return { width: Math.max(1, Math.round(box.width)), height: Math.max(1, Math.round(box.height)) };
  }
  const length = box.lineLength ?? box.width;
  const thickness = box.lineThickness ?? box.height;
  const tall = box.height >= box.width;
  return tall ? { width: Math.max(1, Math.round(thickness)), height: Math.max(1, Math.round(length)) } : { width: Math.max(1, Math.round(length)), height: Math.max(1, Math.round(thickness)) };
}
function uprightFrame(box) {
  const angle = angleOf(box);
  const { width, height } = cropSize(box);
  return {
    centre: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    along: { x: Math.cos(angle), y: Math.sin(angle) },
    across: { x: -Math.sin(angle), y: Math.cos(angle) },
    width,
    height
  };
}
function drawUpright(context, bitmap2, box, width, height) {
  const frame = uprightFrame(box);
  context.save();
  context.translate(width / 2, height / 2);
  context.rotate(-angleOf(box));
  context.translate(-frame.centre.x, -frame.centre.y);
  context.drawImage(bitmap2, 0, 0);
  context.restore();
}

// src/lib/ocr/prepare.ts
function buildOcrInput(bitmap2, box, vertical) {
  const size = cropSize(box);
  const thickness = vertical ? size.width : size.height;
  const length = vertical ? size.height : size.width;
  const scale = OCR_INPUT_HEIGHT / Math.max(1, thickness);
  const rawWidth = Math.max(1, Math.round(length * scale));
  const width = Math.min(OCR_INPUT_WIDTH, Math.ceil(rawWidth / 32) * 32);
  const contentWidth = Math.min(width, rawWidth);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = OCR_INPUT_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The browser refused a 2D context for the crop.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, OCR_INPUT_HEIGHT);
  const upright = document.createElement("canvas");
  upright.width = Math.max(1, Math.round(size.width));
  upright.height = Math.max(1, Math.round(size.height));
  const uprightContext = upright.getContext("2d");
  if (!uprightContext) throw new Error("The browser refused a 2D context for the upright crop.");
  drawUpright(uprightContext, bitmap2, box, upright.width, upright.height);
  if (vertical) {
    context.translate(0, OCR_INPUT_HEIGHT);
    context.rotate(-Math.PI / 2);
    context.drawImage(upright, 0, 0, upright.width, upright.height, 0, 0, OCR_INPUT_HEIGHT, contentWidth);
  } else {
    context.drawImage(upright, 0, 0, upright.width, upright.height, 0, 0, contentWidth, OCR_INPUT_HEIGHT);
  }
  const pixels = context.getImageData(0, 0, width, OCR_INPUT_HEIGHT).data;
  const plane = width * OCR_INPUT_HEIGHT;
  const data2 = new Float32Array(3 * plane);
  const offsetBase = OCR_NORMALIZE === "minus_one" ? 127.5 : 255;
  const shift = OCR_NORMALIZE === "minus_one" ? 1 : 0;
  for (let index = 0; index < plane; index += 1) {
    const offset = index * 4;
    data2[index] = pixels[offset] / offsetBase - shift;
    data2[plane + index] = pixels[offset + 1] / offsetBase - shift;
    data2[2 * plane + index] = pixels[offset + 2] / offsetBase - shift;
  }
  return { data: data2, dims: [1, 3, OCR_INPUT_HEIGHT, width], width };
}

// src/lib/ocr/recognize.ts
var webgpu = typeof navigator !== "undefined" && "gpu" in navigator;
var sessionPromise = null;
function loadSession() {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(chrome.runtime.getURL(OCR_MODEL_PATH), {
      executionProviders: webgpu ? ["webgpu", "wasm"] : ["wasm"],
      graphOptimizationLevel: "all"
    }).catch(async (cause) => {
      if (!webgpu) {
        sessionPromise = null;
        throw cause;
      }
      console.warn("WebGPU OCR failed, using WASM.", cause);
      try {
        return await ort.InferenceSession.create(chrome.runtime.getURL(OCR_MODEL_PATH), {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all"
        });
      } catch (fallbackCause) {
        sessionPromise = null;
        throw fallbackCause;
      }
    });
  }
  void sessionPromise.then(() => console.info(`OCR provider: ${webgpu ? "webgpu preferred" : "wasm"}`));
  return sessionPromise;
}
async function recognizeLine(bitmap2, box, vertical) {
  const [session, charset] = await Promise.all([
    loadSession(),
    loadCharset(chrome.runtime.getURL(OCR_DICT_PATH))
  ]);
  const input = buildOcrInput(bitmap2, box, vertical);
  const inputName = session.inputNames[0];
  if (!inputName) throw new Error("The recogniser exposes no input.");
  const tensor = new ort.Tensor("float32", input.data, input.dims);
  const outputs = await session.run({ [inputName]: tensor });
  const first = Object.values(outputs)[0];
  if (!first || !(first.data instanceof Float32Array)) throw new Error("The recogniser returned no logits.");
  const dims = first.dims;
  const timeSteps = dims[dims.length - 2] ?? 0;
  const classes = dims[dims.length - 1] ?? 0;
  return decodeCtc(first.data, timeSteps, classes, charset);
}

// .dsh/tmp/probe-seg.mjs
await prepareOrt();
var bitmap = await loadImage("fixtures/page-forty.jpg");
var page = createCanvas(bitmap.width, bitmap.height);
page.getContext("2d").drawImage(bitmap, 0, 0);
var L = -10 * Math.PI / 180;
var cos = Math.cos(L);
var sin = Math.sin(L);
var x0 = 300;
var y0 = 565;
var x1 = 400;
var y1 = 745;
var data = page.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0).data;
var pts = [];
for (let y = 0; y < y1 - y0; y += 1) {
  for (let x = 0; x < x1 - x0; x += 1) {
    const at = (y * (x1 - x0) + x) * 4;
    const l = 0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2];
    if (l > 200) pts.push({ x: x0 + x, y: y0 + y });
  }
}
console.log("bright", pts.length);
var uOf = (p) => p.x * cos + p.y * sin;
var vOf = (p) => -p.x * sin + p.y * cos;
var us = pts.map(uOf);
var uMin = Math.floor(Math.min(...us));
var uMax = Math.ceil(Math.max(...us));
var bins = new Uint32Array(uMax - uMin + 1);
for (const value of us) bins[Math.round(value - uMin)] += 1;
var line = "";
for (let i = 0; i < bins.length; i += 1) line += `${uMin + i}:${bins[i]} `;
console.log("u profile", line);
var bands = [];
var start = null;
for (let i = 0; i < bins.length; i += 1) {
  if (bins[i] > 0) {
    if (start === null) start = i;
  } else if (start !== null) {
    bands.push([uMin + start, uMin + i]);
    start = null;
  }
}
if (start !== null) bands.push([uMin + start, uMax]);
var merged = [];
for (const [a, b] of bands) {
  const prev = merged[merged.length - 1];
  if (prev && a - prev[1] <= 2) prev[1] = b;
  else merged.push([a, b]);
}
console.log("bands", merged.map(([a, b]) => `${a}..${b}(${b - a})`).join(" | "));
for (const [a, b] of merged) {
  if (b - a < 10) continue;
  const inside = pts.filter((p) => uOf(p) >= a && uOf(p) <= b);
  if (inside.length < 40) continue;
  const vs = inside.map(vOf);
  const v0 = Math.min(...vs), v1 = Math.max(...vs);
  const uc = (a + b) / 2, vc = (v0 + v1) / 2;
  const px = uc * cos - vc * sin, py = uc * sin + vc * cos;
  const thickness = b - a, length = v1 - v0;
  const box = { x: px - thickness / 2, y: py - length / 2, width: thickness, height: length, score: 1, angle: L, lineLength: length, lineThickness: thickness };
  const out = await recognizeLine(bitmap, box, true).catch((e) => ({ error: e.message }));
  console.log("band", `${a}..${b}`, "th", thickness, "len", length.toFixed(0), "centre", px.toFixed(0), py.toFixed(0), JSON.stringify(out));
  const up = createCanvas(Math.round(thickness), Math.round(length));
  drawUpright(up.getContext("2d"), bitmap, box, up.width, up.height);
  const c = createCanvas(up.width * 5, up.height * 5);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(up, 0, 0, c.width, c.height);
  writeFileSync(`.dsh/tmp/seg-${a}.png`, c.toBuffer("image/png"));
}
