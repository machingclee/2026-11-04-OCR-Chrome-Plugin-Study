import { createCanvas, loadImage, prepareOrt, readApiKey } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { readBlockRegions } from '../../src/lib/ocr/cloudOcr.ts';
import { blockCropBox } from '../../src/lib/ocr/blockCrop.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-325.jpg');
const detected = await detectLines(bitmap, []);
const near = detected.blkBoxes.filter(b => b.x < 1000 && b.x + b.width > 930 && b.y < 200 && b.y + b.height > 130);
console.log('blk near', near.map(b => ({ x: +b.x.toFixed(0), y: +b.y.toFixed(0), w: +b.width.toFixed(0), h: +b.height.toFixed(0), score: +b.score.toFixed(2) })));
const boxes = detected.detBoxes.filter(b => b.x < 1010 && b.x + b.width > 900 && b.y < 420 && b.y + b.height > 130);
console.log('det near', boxes.map(b => ({ x: +b.x.toFixed(0), y: +b.y.toFixed(0), w: +b.width.toFixed(0), h: +b.height.toFixed(0) })));
const key = readApiKey();
const readings = await readBlockRegions(bitmap, near.map(b => ({ ...b })), { provider: 'deepseek', key }, detected.detBoxes, detected.mask);
for (const r of readings) {
  const crop = blockCropBox(bitmap.width, bitmap.height, r.block, r.boxes ?? []);
  console.log('BLOCK', JSON.stringify(r.block), 'crop w', crop.width.toFixed(0));
  console.log('HINT', JSON.stringify(r.hint));
  console.log('RAW', r.raw);
  console.log('REGIONS', JSON.stringify(r.regions.map(g => ({
    text: g.text, x: +g.x.toFixed(0), y: +g.y.toFixed(0), w: +g.width.toFixed(0), h: +g.height.toFixed(0),
    angle: g.angle && +(g.angle * 180 / Math.PI).toFixed(1), glyph: g.glyphSize && +g.glyphSize.toFixed(1),
    lineLength: g.lineLength && +g.lineLength.toFixed(0), boxIds: g.boxIds,
  }))));
  if (r.cropUrl) {
    const b = Buffer.from(r.cropUrl.slice(r.cropUrl.indexOf(',') + 1), 'base64');
    (await import('node:fs')).writeFileSync('.dsh/tmp/font-crop.jpg', b);
  }
}
