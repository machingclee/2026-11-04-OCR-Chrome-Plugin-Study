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

// .dsh/tmp/probe-pca.mjs
var bitmap = await loadImage("fixtures/page-forty.jpg");
var c = createCanvas(bitmap.width, bitmap.height);
c.getContext("2d").drawImage(bitmap, 0, 0);
var x0 = 312;
var y0 = 582;
var w = 78;
var h = 155;
var data = c.getContext("2d").getImageData(x0, y0, w, h).data;
var pts = [];
for (let y = 0; y < h; y += 1) {
  for (let x = 0; x < w; x += 1) {
    const at = (y * w + x) * 4;
    const l = 0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2];
    if (l > 190) pts.push({ x: x0 + x, y: y0 + y });
  }
}
console.log("bright points", pts.length);
var mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
var my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
var sxx = 0;
var syy = 0;
var sxy = 0;
for (const p of pts) {
  const dx = p.x - mx, dy = p.y - my;
  sxx += dx * dx;
  syy += dy * dy;
  sxy += dx * dy;
}
var theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
console.log("pca theta rad", theta, "deg", theta * 180 / Math.PI, "centre", mx.toFixed(1), my.toFixed(1));
console.log("eigen-ish", sxx / pts.length, syy / pts.length, sxy / pts.length);
