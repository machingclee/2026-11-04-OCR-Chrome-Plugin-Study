import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { applyInclination } from '../../src/lib/ocr/cloudOcr.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const bands = [325, 348, 371].map((x, i) => ({ x, y: 580, width: 22, height: 150, heightOk: true }));
const regions = bands.map((b, i) => ({ x: b.x, y: b.y, width: b.width, height: b.height, text: `r${i}`, direction: 'v', columns: 1, rows: 1, kind: 'chat' }));
applyInclination(regions, [], detected.mask);
for (const r of regions) console.log('band', r.x.toFixed(0), 'angle', r.angle === undefined ? 'none' : (r.angle * 180 / Math.PI).toFixed(2), 'glyph', r.glyphSize?.toFixed(1), 'len', r.lineLength?.toFixed(0));
// whole box
const whole = [{ x: 312, y: 582, width: 78, height: 155, text: 'w', direction: 'v', columns: 1, rows: 1, kind: 'chat' }];
applyInclination(whole, [], detected.mask);
console.log('whole angle', whole[0].angle === undefined ? 'none' : (whole[0].angle * 180 / Math.PI).toFixed(2), 'glyph', whole[0].glyphSize?.toFixed(1));
