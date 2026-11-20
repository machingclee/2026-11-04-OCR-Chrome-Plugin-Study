import { createCanvas, loadImage, prepareOrt, readApiKey } from '../../scripts/harness/env.mjs';
import {
  requestDeepSeek, readBlockRegions, dropReadingsInsideColumns, mergeCompanionRegions, separateOverlaps,
} from '../../src/lib/ocr/cloudOcr.ts';
import { detectLines } from '../../src/lib/detect/index.ts';
import { blockCropDataUrl, blockCropBox } from '../../src/lib/ocr/blockCrop.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const blk = detected.blkBoxes.find(b => b.x > 310 && b.x < 330 && b.y > 570 && b.y < 590);
const padded = blockCropBox(bitmap.width, bitmap.height, { ...blk });
const inside = detected.detBoxes.filter(box => box.x < padded.x + padded.width && box.x + box.width > padded.x && box.y < padded.y + padded.height && box.y + box.height > padded.y)
  .map(box => ({ x: box.x, y: box.y, width: box.width, height: box.height }));
const cut = blockCropDataUrl(bitmap, bitmap.width, bitmap.height, { ...blk }, inside);
const key = readApiKey();
const readings = await readBlockRegions(bitmap, [{ ...blk }], { provider: 'deepseek', key }, detected.detBoxes, detected.mask);
const regions = readings[0].regions;
console.log('final', regions.length, regions.map(r => r.text));
