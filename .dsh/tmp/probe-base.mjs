import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage, prepareOrt, readApiKey } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { readBlockRegions } from '../../src/lib/ocr/cloudOcr.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const blk = detected.blkBoxes.filter(b => b.x < 460 && b.x + b.width > 280 && b.y < 760 && b.y + b.height > 520);
console.log('blk', JSON.stringify(blk));
const key = readApiKey();
const readings = await readBlockRegions(bitmap, blk.map(b => ({ ...b })), { provider: 'deepseek', key }, detected.detBoxes, detected.mask);
for (const r of readings) {
  console.log('BLOCK', JSON.stringify(r.block));
  console.log('BOXES', JSON.stringify(r.boxes));
  console.log('RAW', r.raw);
  console.log('REGIONS', JSON.stringify(r.regions.map(g => ({ text: g.text, angle: g.angle && +(g.angle * 180 / Math.PI).toFixed(2), frame: g.frame, glyph: g.glyphSize, cols: g.columns })), null, 1));
  if (r.cropUrl) {
    const b = Buffer.from(r.cropUrl.slice(r.cropUrl.indexOf(',') + 1), 'base64');
    writeFileSync(`.dsh/tmp/base-crop-${Math.round(r.block.x)}.jpg`, b);
  }
}
