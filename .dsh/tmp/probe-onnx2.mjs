import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { recognizeLine } from '../../src/lib/ocr/recognize.ts';
import { applyInclination } from '../../src/lib/ocr/cloudOcr.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const box = detected.detBoxes.find(b => b.x > 300 && b.x < 330 && b.y > 570 && b.y < 600);
console.log('box', JSON.stringify(box));
const region = { x: box.x, y: box.y, width: box.width, height: box.height, text: 'x', direction: 'v', columns: 1, rows: 1, kind: 'chat' };
applyInclination([region], [box], detected.mask);
console.log('region', JSON.stringify({ ...region, mask: undefined }));
const whole = { x: region.x, y: region.y, width: region.width, height: region.height, score: box.score, angle: region.angle, lineLength: region.lineLength, lineThickness: region.lineThickness };
console.log('whole ocr', JSON.stringify(await recognizeLine(bitmap, whole, true).catch(e => ({ error: e.message }))));
// one crop per 26px band inside the box, same angle
for (let i = 0; i < 3; i += 1) {
  const thickness = 26;
  const x = box.x + i * (box.width - thickness) / 2;
  const band = { x, y: box.y, width: thickness, height: box.height, score: box.score, angle: region.angle, lineLength: region.lineLength, lineThickness: thickness };
  const out = await recognizeLine(bitmap, band, true).catch(e => ({ error: e.message }));
  console.log('band', i, JSON.stringify(out));
}
