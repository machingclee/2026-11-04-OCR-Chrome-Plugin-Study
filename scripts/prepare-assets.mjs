import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const modelTarget = join(root, 'public', 'models', 'comictextdetector.pt.onnx');
const MODEL_URL =
  'https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/comictextdetector.pt.onnx';
const MODEL_SIZE = 94669756;
const MODEL_SHA256 = '1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f';

async function sha256(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

async function ensureModel() {
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
  console.log(`downloading ${MODEL_URL}`);
  const response = await fetch(MODEL_URL, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`);
  }
  await new Promise((resolve, reject) => {
    const out = createWriteStream(modelTarget);
    Readable.fromWeb(response.body).pipe(out).on('finish', resolve).on('error', reject);
  });

  const written = await stat(modelTarget);
  if (written.size !== MODEL_SIZE) throw new Error(`unexpected size: ${written.size}`);
  const digest = await sha256(modelTarget);
  if (digest !== MODEL_SHA256) throw new Error(`unexpected sha256: ${digest}`);
  console.log('detector model downloaded and verified');
}

await ensureModel();
