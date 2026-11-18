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

// src/lib/ocr/recognize.ts
import * as ort from "onnxruntime-web/webgpu";
var webgpu = typeof navigator !== "undefined" && "gpu" in navigator;

// .dsh/tmp/probe-cc.mjs
await prepareOrt();
var bitmap = await loadImage("fixtures/page-forty.jpg");
var page = createCanvas(bitmap.width, bitmap.height);
page.getContext("2d").drawImage(bitmap, 0, 0);
var x0 = 300;
var y0 = 560;
var x1 = 400;
var y1 = 750;
var w = x1 - x0;
var h = y1 - y0;
var data = page.getContext("2d").getImageData(x0, y0, w, h).data;
var lum = new Float64Array(w * h);
for (let i = 0; i < w * h; i += 1) lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
var dark = new Uint8Array(w * h);
for (let i = 0; i < w * h; i += 1) dark[i] = lum[i] < 140 ? 1 : 0;
var seen = new Uint8Array(w * h);
var comps = [];
for (let start = 0; start < w * h; start += 1) {
  if (!dark[start] || seen[start]) continue;
  const stack = [start];
  seen[start] = 1;
  const pts = [];
  let border = false;
  while (stack.length > 0) {
    const at = stack.pop();
    const x = at % w, y = (at - x) / w;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
    pts.push({ x, y });
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const next = ny * w + nx;
      if (dark[next] && !seen[next]) {
        seen[next] = 1;
        stack.push(next);
      }
    }
  }
  if (border) continue;
  if (pts.length < 6 || pts.length > 600) continue;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  comps.push({
    n: pts.length,
    cx: xs.reduce((a, b) => a + b, 0) / pts.length + x0,
    cy: ys.reduce((a, b) => a + b, 0) / pts.length + y0,
    bw: Math.max(...xs) - Math.min(...xs) + 1,
    bh: Math.max(...ys) - Math.min(...ys) + 1
  });
}
console.log("components", comps.length);
console.log(comps.map((c) => `(${c.cx.toFixed(0)},${c.cy.toFixed(0)} ${c.bw}x${c.bh} n${c.n})`).join(" "));
var L = -10 * Math.PI / 180;
var cos = Math.cos(L);
var sin = Math.sin(L);
var uOf = (p) => p.cx * cos + p.cy * sin;
var us = comps.map(uOf).sort((a, b) => a - b);
console.log("u sorted", us.map((v) => v.toFixed(1)).join(" "));
var bands = [];
var current = [us[0]];
for (let i = 1; i < us.length; i += 1) {
  if (us[i] - us[i - 1] > 7) {
    bands.push(current);
    current = [];
  }
  current.push(us[i]);
}
bands.push(current);
console.log("clusters", bands.map((b) => `${b[0].toFixed(0)}..${b[b.length - 1].toFixed(0)} (${b.length})`).join(" | "));
