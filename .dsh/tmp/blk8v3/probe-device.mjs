import { loadImage, prepareOrt } from '../../../scripts/harness/env.mjs';
import { recognizeLine } from '../../../src/lib/ocr/recognize.ts';
await prepareOrt();
const img = await loadImage('fixtures/page-forty.jpg');
const angle = 5.4 * Math.PI / 180;
const boxes = [
  { name: 'right', x: 342, y: 575, width: 44, height: 140, lineLength: 140, lineThickness: 30 },
  { name: 'middle', x: 310, y: 580, width: 40, height: 150, lineLength: 150, lineThickness: 30 },
  { name: 'left', x: 278, y: 595, width: 42, height: 145, lineLength: 145, lineThickness: 30 },
];
for (const b of boxes) {
  const box = { ...b, score: 1, angle, direction: 'vertical', ruby: [] };
  const t = Date.now();
  const r = await recognizeLine(img, box, true);
  console.log(b.name, JSON.stringify(r.text), 'conf', r.confidence.toFixed(2), 'ms', Date.now() - t);
}
