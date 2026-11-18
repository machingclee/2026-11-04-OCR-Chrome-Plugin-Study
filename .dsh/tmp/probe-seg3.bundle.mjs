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
var webgpu = typeof navigator !== "undefined" && "gpu" in navigator;

// .dsh/tmp/probe-seg3.mjs
await prepareOrt();
var bitmap = await loadImage("fixtures/page-forty.jpg");
var page = createCanvas(bitmap.width, bitmap.height);
page.getContext("2d").drawImage(bitmap, 0, 0);
var x0 = 300;
var y0 = 565;
var x1 = 400;
var y1 = 745;
var w = x1 - x0;
var h = y1 - y0;
var data = page.getContext("2d").getImageData(x0, y0, w, h).data;
var lum = new Float64Array(w * h);
for (let i = 0; i < w * h; i += 1) lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
var glow = new Uint8Array(w * h);
for (let i = 0; i < w * h; i += 1) glow[i] = lum[i] > 175 ? 1 : 0;
var glyph = [];
for (let y = 2; y < h - 2; y += 1) {
  for (let x = 2; x < w - 2; x += 1) {
    if (lum[y * w + x] > 120) continue;
    let bright = 0;
    for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) bright += glow[(y + dy) * w + (x + dx)];
    if (bright >= 10) glyph.push({ x: x0 + x, y: y0 + y });
  }
}
console.log("glyph points", glyph.length);
var L = -10 * Math.PI / 180;
var cos = Math.cos(L);
var sin = Math.sin(L);
var uOf = (p) => p.x * cos + p.y * sin;
var us = glyph.map(uOf);
var uMin = Math.floor(Math.min(...us));
var uMax = Math.ceil(Math.max(...us));
var bins = new Uint32Array(uMax - uMin + 1);
for (const value of us) bins[Math.round(value - uMin)] += 1;
var line = "";
for (let i = 0; i < bins.length; i += 1) line += `${uMin + i}:${bins[i]} `;
console.log("u profile", line);
