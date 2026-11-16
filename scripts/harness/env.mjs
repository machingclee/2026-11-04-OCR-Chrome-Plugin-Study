/**
 * The browser surfaces the extension pipeline uses, for Node.
 *
 * `runDetection` is written against OffscreenCanvas, `document.createElement`,
 * `createImageBitmap` and `chrome.runtime.getURL`. A real canvas implementation
 * supplies all of them, so the harness runs the same detection, reading and
 * erase code the extension runs, not a copy of it.
 *
 * The canvas build is a native module. The repo does not depend on it, because
 * the extension ships without it, so it is resolved in this order:
 *
 *   1. CANVAS_ROOT — a directory whose node_modules holds `canvas`;
 *   2. this repo's node_modules;
 *   3. the ShinobuTranslator checkout, which is where this workspace has always
 *      taken it from (see docs/detection-pipeline.md).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export const ROOT = process.cwd();

const candidates = [
    process.env.CANVAS_ROOT,
    `${ROOT}/node_modules`,
    '/Users/chingcheonglee/Repos/Javascript/ShinobuTranslator/node_modules',
].filter((value) => typeof value === 'string' && value.length > 0);

let canvasModule = null;
const tried = [];
for (const directory of candidates) {
    try {
        canvasModule = createRequire(`${directory}/package.json`)('canvas');
        break;
    } catch (cause) {
        tried.push(`${directory}: ${cause instanceof Error ? cause.code ?? cause.message : String(cause)}`);
    }
}
if (!canvasModule) {
    throw new Error([
        'No canvas implementation found, so the pipeline cannot render in Node.',
        'Install one with `npm install --no-save canvas`, or point CANVAS_ROOT at a',
        'checkout whose node_modules holds it. Tried:',
        ...tried.map((line) => `  ${line}`),
    ].join('\n'));
}

export const { createCanvas, loadImage } = canvasModule;

globalThis.OffscreenCanvas = class OffscreenCanvasShim {
    constructor(width, height) {
        return createCanvas(width, height);
    }
};

globalThis.document = {
    createElement: (tag) => {
        if (tag !== 'canvas') throw new Error(`The page harness only creates canvases, not <${tag}>.`);
        return createCanvas(1, 1);
    },
};

// Polyfill when the canvas build leaves it out.
if (typeof globalThis.ImageData === 'undefined' && canvasModule.ImageData) {
    globalThis.ImageData = canvasModule.ImageData;
}

/** Decode a Blob into something node-canvas can draw. */
globalThis.createImageBitmap = async (blob) => loadImage(Buffer.from(await blob.arrayBuffer()));

globalThis.chrome = {
    runtime: {
        getURL: (path) => `${ROOT}/public/${path}`,
    },
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    // The models and the dictionary are fetched through chrome.runtime.getURL,
    // which is a local path here.
    if (typeof url === 'string' && url.startsWith('/')) {
        return new Response(readFileSync(url), {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
        });
    }
    return realFetch(input, init);
};

/**
 * Point onnxruntime at the wasm files the extension ships beside it. The
 * detector imports the plain build and the recogniser imports the webgpu build,
 * which are two module instances with two `env` objects; both need the paths,
 * or the first recogniser call fails with "no available backend found".
 */
export async function prepareOrt() {
    const [{ default: ort }, webgpu] = await Promise.all([
        import('onnxruntime-web'),
        import('onnxruntime-web/webgpu'),
    ]);
    for (const instance of [ort, webgpu]) {
        instance.env.wasm.numThreads = 1;
        instance.env.wasm.proxy = false;
        instance.env.wasm.wasmPaths = `${ROOT}/node_modules/onnxruntime-web/dist/`;
    }
    return ort;
}

/** The DeepSeek key, from the environment or the repo's git-ignored .env. */
export function readApiKey() {
    const fromEnvironment = process.env.DEEPSEEK_API_KEY ?? process.env.VITE_DEEPSEEK_API_KEY;
    if (fromEnvironment && fromEnvironment.trim().length > 0) return fromEnvironment.trim();
    try {
        const text = readFileSync(`${ROOT}/.env`, 'utf8');
        const value = text.match(/^\s*(?:VITE_)?DEEPSEEK_API_KEY\s*=\s*(.*)$/m)?.[1]?.trim() ?? '';
        return value.replace(/^['"]|['"]$/g, '');
    } catch {
        return '';
    }
}
