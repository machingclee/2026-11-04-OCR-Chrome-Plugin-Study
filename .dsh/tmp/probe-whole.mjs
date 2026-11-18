import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { recognizeLine } from '../../src/lib/ocr/recognize.ts';
import { drawUpright } from '../../src/lib/warp.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
for (const deg of [-20, -18, -16, -14, -12, -10]) {
  const L = deg * Math.PI / 180;
  for (const [cx, cy, th, len] of [[351, 660, 66, 150], [355, 660, 70, 155], [352, 655, 62, 145]]) {
    const box = { x: cx - th / 2, y: cy - len / 2, width: th, height: len, score: 1, angle: L, lineLength: len, lineThickness: th };
    const out = await recognizeLine(bitmap, box, true).catch(e => ({ text: 'ERR', confidence: 0 }));
    console.log(deg, `${cx},${cy} ${th}x${len}`, JSON.stringify(out));
  }
}
