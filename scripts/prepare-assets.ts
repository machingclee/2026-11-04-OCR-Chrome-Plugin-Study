import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const modelTarget = join(root, 'public', 'models', 'comictextdetector.pt.onnx');
const MODEL_URL =
    'https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/comictextdetector.pt.onnx';
const ocrTarget = join(root, 'public', 'models', 'ppocr_v6_medium_rec.onnx');
const OCR_MODEL_URL =
    'https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_rec_onnx/resolve/main/inference.onnx';
const OCR_MODEL_SIZE = 76_554_979;
const OCR_MODEL_SHA256 = '9c09abf0957f7968c7586464b7397b84ad2387a0497a351af40e9acc71b673ba';

const dictTarget = join(root, 'public', 'models', 'ppocr_v6_dict.txt');
const CONFIG_URL = 'https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_rec_onnx/resolve/main/inference.yml';
const CONFIG_SIZE = 150_580;
const CONFIG_SHA256 = '991b700facf5b50a7de193468207d5f4255b538dde0d312ae3b7c7a9b6873129';
const DICT_SIZE = 74_944;
const DICT_SHA256 = '118d0f0714ad2a37668c23d6541f2c3feb65b8214041265b567f7fd5b3365d8e';

const MODEL_SIZE = 94_669_756;
const MODEL_SHA256 = '1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f';

async function sha256(path: string): Promise<string> {
    const hash = createHash('sha256');
    hash.update(await readFile(path));
    return hash.digest('hex');
}

async function download(target: string, url: string): Promise<void> {
    console.log(`downloading ${url}`);
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
        throw new Error(`download failed: ${response.status} ${response.statusText}`);
    }

    const file = createWriteStream(target);
    const reader = response.body.getReader();

    await new Promise<void>((resolve, reject) => {
        file.on('error', reject);
        file.on('finish', () => resolve());

        void (async () => {
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value && !file.write(value)) await once(file, 'drain');
                }
                file.end();
            } catch (cause) {
                reject(cause instanceof Error ? cause : new Error(String(cause)));
            }
        })();
    });
}

async function ensureFile(
    target: string,
    url: string,
    size: number,
    digest: string,
    label: string,
): Promise<void> {
    const existing = await stat(target).catch(() => null);
    if (existing && existing.size === size && (await sha256(target)) === digest) {
        console.log(`${label} already present`);
        return;
    }

    await mkdir(dirname(target), { recursive: true });
    await download(target, url);

    const written = await stat(target);
    if (written.size !== size) throw new Error(`${label}: unexpected size ${written.size}`);
    const actual = await sha256(target);
    if (actual !== digest) throw new Error(`${label}: unexpected sha256 ${actual}`);
    console.log(`${label} downloaded and verified`);
}

/**
 * The charset ships inside inference.yml, so the script reads the config and
 * writes the plain list the extension fetches at runtime.
 */
async function ensureCharset(): Promise<void> {
    const existing = await stat(dictTarget).catch(() => null);
    if (existing && existing.size === DICT_SIZE && (await sha256(dictTarget)) === DICT_SHA256) {
        console.log('recogniser charset already present');
        return;
    }

    console.log(`downloading ${CONFIG_URL}`);
    const response = await fetch(CONFIG_URL, { redirect: 'follow' });
    if (!response.ok) throw new Error(`config download failed: ${response.status}`);
    const config = Buffer.from(await response.arrayBuffer());
    if (config.byteLength !== CONFIG_SIZE) throw new Error(`unexpected config size: ${config.byteLength}`);
    const configDigest = createHash('sha256').update(config).digest('hex');
    if (configDigest !== CONFIG_SHA256) throw new Error(`unexpected config sha256: ${configDigest}`);

    const lines = config.toString('utf8').split('\n');
    const start = lines.findIndex((line) => line.trim() === 'character_dict:');
    if (start < 0) throw new Error('the config holds no character_dict');

    const chars: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (!line.startsWith('  - ')) {
            if (line.trim().length === 0) continue;
            break;
        }
        let value = line.slice(4).trim();
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replaceAll("''", "'");
        else if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        chars.push(value);
    }

    const output = `${chars.join('\n')}\n`;
    await mkdir(dirname(dictTarget), { recursive: true });
    await writeFile(dictTarget, output, 'utf8');

    const written = await stat(dictTarget);
    if (written.size !== DICT_SIZE) throw new Error(`unexpected charset size: ${written.size}`);
    const digest = await sha256(dictTarget);
    if (digest !== DICT_SHA256) throw new Error(`unexpected charset sha256: ${digest}`);
    console.log('recogniser charset written and verified');
}

async function ensureModel(): Promise<void> {
    const existing = await stat(modelTarget).catch(() => null);
    if (existing && existing.size === MODEL_SIZE) {
        const digest = await sha256(modelTarget);
        if (digest === MODEL_SHA256) {
            console.log('detector model already present');
            return;
        }
        console.warn('detector model has the wrong hash, downloading again');
    }

    await mkdir(dirname(modelTarget), { recursive: true });
    await download(modelTarget, MODEL_URL);

    const written = await stat(modelTarget);
    if (written.size !== MODEL_SIZE) throw new Error(`unexpected size: ${written.size}`);
    const digest = await sha256(modelTarget);
    if (digest !== MODEL_SHA256) throw new Error(`unexpected sha256: ${digest}`);
    console.log('detector model downloaded and verified');
}

await ensureModel();
await ensureFile(ocrTarget, OCR_MODEL_URL, OCR_MODEL_SIZE, OCR_MODEL_SHA256, 'recogniser model');
await ensureCharset();
