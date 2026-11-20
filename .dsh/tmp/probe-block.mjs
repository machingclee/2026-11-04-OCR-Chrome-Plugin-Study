import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage, prepareOrt, readApiKey } from '../../scripts/harness/env.mjs';
import { readBlockRegions } from '../../src/lib/ocr/cloudOcr.ts';
import { detectLines } from '../../src/lib/detect/index.ts';

await prepareOrt();
const img = await loadImage('fixtures/page-forty.jpg');
const bitmap = img;
const detected = await detectLines(bitmap, []);
const wanted = [
  { x: 312, y: 580, width: 73, height: 135, score: 0.55 },   // BLK 8
  { x: 202, y: 983, width: 146, height: 376, score: 0.97 },   // BLK 7
];
const key = readApiKey();
const readings = await readBlockRegions(bitmap, wanted, { provider: 'deepseek', key }, detected.detBoxes, detected.mask);
for (const r of readings) {
  console.log('BLOCK', JSON.stringify(r.block));
  console.log('BOXES', JSON.stringify(r.boxes));
  console.log('RAW', r.raw);
  console.log('REGIONS', JSON.stringify(r.regions, null, 1));
}
writeFileSync('.dsh/tmp/probe-crop.json', JSON.stringify(readings.map(r => ({ block: r.block, boxes: r.boxes, raw: r.raw, cropUrl: r.cropUrl })), null, 1));
