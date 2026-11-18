import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { recognizeLine } from '../../src/lib/ocr/recognize.ts';
import { drawUpright } from '../../src/lib/warp.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const bands = [
  { name: 'hero', x: 316, w: 32 },
  { name: 'atsui', x: 344, w: 32 },
  { name: 'yappa', x: 362, w: 32 },
];
for (const angleDeg of [8, 10, 12, 14]) {
  const L = angleDeg * Math.PI / 180;
  for (const band of bands) {
    const line = { x: band.x, y: 585, width: band.w, height: 150, score: 1, angle: L, lineLength: 150, lineThickness: band.w };
    const out = await recognizeLine(bitmap, line, true).catch(e => ({ error: e.message }));
    console.log(angleDeg, band.name, JSON.stringify(out));
    if (angleDeg === 12) {
      const up = createCanvas(band.w, 150);
      drawUpright(up.getContext('2d'), bitmap, line, up.width, up.height);
      const c = createCanvas(up.width * 6, 900);
      c.getContext('2d').drawImage(up, 0, 0, c.width, c.height);
      writeFileSync(`.dsh/tmp/col2-${band.name}.png`, c.toBuffer('image/png'));
    }
  }
}
