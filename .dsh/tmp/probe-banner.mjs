import { createCanvas, loadImage, prepareOrt, readApiKey } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { readBlockRegions } from '../../src/lib/ocr/cloudOcr.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const blk = detected.blkBoxes.filter(b => b.y > 950 && b.x < 300);
console.log('blk', blk.map(b => ({ x: +b.x.toFixed(0), y: +b.y.toFixed(0), w: +b.width.toFixed(0), h: +b.height.toFixed(0) })));
const inside = detected.detBoxes.filter(box => box.y > 950 && box.x < 300);
console.log('det', inside.map(b => ({ x: +b.x.toFixed(0), y: +b.y.toFixed(0), w: +b.width.toFixed(0), h: +b.height.toFixed(0) })));
const key = readApiKey();
const readings = await readBlockRegions(bitmap, blk.map(b => ({ ...b })), { provider: 'deepseek', key }, detected.detBoxes, detected.mask);
for (const r of readings) {
  console.log('RAW', r.raw);
  console.log('REGIONS', JSON.stringify(r.regions.map(g => ({
    text: g.text, boxIds: g.boxIds, own: g.own, x: +g.x.toFixed(0), y: +g.y.toFixed(0), w: +g.width.toFixed(0), h: +g.height.toFixed(0),
    angle: g.angle && +(g.angle * 180 / Math.PI).toFixed(1), glyph: g.glyphSize && +g.glyphSize.toFixed(1), lineLength: g.lineLength && +g.lineLength.toFixed(0),
  }))));
}
