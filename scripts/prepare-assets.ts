import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const modelTarget = join(root, 'public', 'models', 'comictextdetector.pt.onnx');
const MODEL_URL =
    'https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/comictextdetector.pt.onnx';
const MODEL_SIZE = 94_669_756;
const MODEL_SHA256 = '1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f';

async function sha256(path: string): Promise<string> {
    const hash = createHash('sha256');
    hash.update(await readFile(path));
    return hash.digest('hex');
}

async function download(target: string): Promise<void> {
    console.log(`downloading ${MODEL_URL}`);
    const response = await fetch(MODEL_URL, { redirect: 'follow' });
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
    await download(modelTarget);

    const written = await stat(modelTarget);
    if (written.size !== MODEL_SIZE) throw new Error(`unexpected size: ${written.size}`);
    const digest = await sha256(modelTarget);
    if (digest !== MODEL_SHA256) throw new Error(`unexpected sha256: ${digest}`);
    console.log('detector model downloaded and verified');
}

await ensureModel();
