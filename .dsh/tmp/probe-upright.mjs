import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { recognizeLine } from '../../src/lib/ocr/recognize.ts';
import { drawUpright } from '../../src/lib/warp.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const cx = 351, cy = 660;
for (const deg of [-14, -12, -10, -8, -6, -4, 0, 4, 8]) {
  const L = deg * Math.PI / 180;
  const thickness = 78;
  const line = { x: cx - thickness / 2, y: cy - 80, width: thickness, height: 160, score: 1, angle: L, lineLength: 160, lineThickness: thickness };
  const out = await recognizeLine(bitmap, line, true).catch(e => ({ error: e.message }));
  console.log('wide', deg, JSON.stringify(out));
  if ([-10, -8].includes(deg)) {
    const up = createCanvas(thickness, 160);
    drawUpright(up.getContext('2d'), bitmap, line, up.width, up.height);
    const c = createCanvas(up.width * 5, 800);
    c.getContext('2d').imageSmoothingEnabled = false;
    c.getContext('2d').drawImage(up, 0, 0, c.width, c.height);
    writeFileSync(`.dsh/tmp/up-${deg}.png`, c.toBuffer('image/png'));
  }
}
