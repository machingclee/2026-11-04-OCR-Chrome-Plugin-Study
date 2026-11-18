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

// .dsh/tmp/find-page2.mjs
import { readdirSync } from "node:fs";
var target = await loadImage("/Users/chingcheonglee/Library/Application Support/dsh-desktop/harness/attachments/v1/objects/b5/b50d25e0e0d8e92a79ad234a9c711c97c989ad8f7f75f473155216a77d593af1");
var signature = (img) => {
  const c = createCanvas(48, 64);
  c.getContext("2d").drawImage(img, 0, 0, img.width, img.height, 0, 0, 48, 64);
  return c.getContext("2d").getImageData(0, 0, 48, 64).data;
};
var t = signature(target);
for (const file of readdirSync("fixtures").filter((f) => f.endsWith(".jpg"))) {
  const img = await loadImage(`fixtures/${file}`);
  const s = signature(img);
  let diff = 0;
  for (let i = 0; i < s.length; i += 4) diff += Math.abs(s[i] - t[i]);
  console.log(file, (diff / (s.length / 4)).toFixed(1));
}
