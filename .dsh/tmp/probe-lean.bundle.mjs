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

// .dsh/tmp/probe-lean.mjs
var bitmap = await loadImage("fixtures/page-forty.jpg");
var c = createCanvas(bitmap.width, bitmap.height);
c.getContext("2d").drawImage(bitmap, 0, 0);
var x0 = 305;
var y0 = 570;
var w = 100;
var h = 180;
var data = c.getContext("2d").getImageData(x0, y0, w, h).data;
var pts = [];
for (let y = 0; y < h; y += 1) {
  for (let x = 0; x < w; x += 1) {
    const at = (y * w + x) * 4;
    const l = 0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2];
    if (l < 215) continue;
    let darkNear = false;
    for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nAt = (ny * w + nx) * 4;
      const nl = 0.299 * data[nAt] + 0.587 * data[nAt + 1] + 0.114 * data[nAt + 2];
      if (nl < 120) {
        darkNear = true;
        break;
      }
    }
    if (darkNear) pts.push({ x: x0 + x, y: y0 + y });
  }
}
console.log("glyph edge points", pts.length);
var score = (deg) => {
  const t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
  const bins = /* @__PURE__ */ new Map();
  for (const p of pts) {
    const u = Math.round(p.x * cos + p.y * sin);
    bins.set(u, (bins.get(u) ?? 0) + 1);
  }
  let sum = 0;
  for (const value of bins.values()) sum += value * value;
  return sum;
};
var results = [];
for (let deg = -25; deg <= 25; deg += 1) results.push({ deg, score: score(deg) });
results.sort((a, b) => b.score - a.score);
console.log("best angles", results.slice(0, 8).map((r) => `${r.deg}:${r.score}`).join(" "));
console.log("worst", results.slice(-3).map((r) => `${r.deg}:${r.score}`).join(" "));
