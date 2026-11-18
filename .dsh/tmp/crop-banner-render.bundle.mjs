// .dsh/tmp/crop-banner-render.mjs
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

// .dsh/tmp/crop-banner-render.mjs
var img = await loadImage("out/regression/incline.png");
var name = process.argv[2] ?? "after";
var c = createCanvas(260, 460);
c.getContext("2d").drawImage(img, 150, 930, 260, 460, 0, 0, 260, 460);
writeFileSync(`docs/loops/assets/banner-${name}.png`, c.toBuffer("image/png"));
console.log(name, img.width, img.height);
