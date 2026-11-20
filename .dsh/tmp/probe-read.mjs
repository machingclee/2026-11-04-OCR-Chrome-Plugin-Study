import { createCanvas, loadImage, prepareOrt, readApiKey } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { readBlockRegions } from '../../src/lib/ocr/cloudOcr.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const blk = detected.blkBoxes.find(b => b.x > 310 && b.x < 330 && b.y > 570 && b.y < 590);
const key = readApiKey();
const readings = await readBlockRegions(bitmap, [{ ...blk }], { provider: 'deepseek', key }, detected.detBoxes, detected.mask);
for (const r of readings) {
  console.log('HINT', JSON.stringify(r.hint));
  console.log('RAW', r.raw);
  console.log('REGIONS', JSON.stringify(r.regions.map(g => ({
    text: g.text, angle: g.angle && +(g.angle * 180 / Math.PI).toFixed(1), glyph: g.glyphSize && +g.glyphSize.toFixed(1), boxIds: g.boxIds,
  }))));
}
