import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { recognizeLine } from '../../src/lib/ocr/recognize.ts';
import { drawUpright } from '../../src/lib/warp.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const cx = 351, cy = 660;
const L = -10 * Math.PI / 180;
const cos = Math.cos(L), sin = Math.sin(L);
for (const thickness of [22, 24, 26]) {
  for (const offset of [-24, -2, 20]) {
    const px = cx + offset * cos, py = cy + offset * sin;
    const line = { x: px - thickness / 2, y: py - 80, width: thickness, height: 160, score: 1, angle: L, lineLength: 160, lineThickness: thickness };
    const out = await recognizeLine(bitmap, line, true).catch(e => ({ error: e.message }));
    console.log('th', thickness, 'off', offset, JSON.stringify(out));
    if (thickness === 24) {
      const up = createCanvas(thickness, 160);
      drawUpright(up.getContext('2d'), bitmap, line, up.width, up.height);
      const c = createCanvas(thickness * 6, 960);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(up, 0, 0, c.width, c.height);
      writeFileSync(`.dsh/tmp/col3-${offset}.png`, c.toBuffer('image/png'));
    }
  }
}
