import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { recognizeLine } from '../../src/lib/ocr/recognize.ts';
import { applyInclination } from '../../src/lib/ocr/cloudOcr.ts';
import { drawUpright } from '../../src/lib/warp.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const box = detected.detBoxes.find(b => b.x > 300 && b.x < 330 && b.y > 570 && b.y < 600);
const region = { x: box.x, y: box.y, width: box.width, height: box.height, text: 'x', direction: 'v', columns: 1, rows: 1, kind: 'chat' };
applyInclination([region], [box], detected.mask);
const L = region.angle;
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
for (const thickness of [50, 66, 78, 90]) {
  const line = { x: cx - thickness / 2, y: cy - 80, width: thickness, height: 160, score: 1, angle: L, lineLength: 160, lineThickness: thickness };
  const out = await recognizeLine(bitmap, line, true).catch(e => ({ error: e.message }));
  console.log('thickness', thickness, JSON.stringify(out));
  const up = createCanvas(Math.round(thickness), 160);
  drawUpright(up.getContext('2d'), bitmap, line, up.width, up.height);
  const c = createCanvas(up.width * 5, up.height * 5);
  c.getContext('2d').drawImage(up, 0, 0, c.width, c.height);
  writeFileSync(`.dsh/tmp/wide-${thickness}.png`, c.toBuffer('image/png'));
}
