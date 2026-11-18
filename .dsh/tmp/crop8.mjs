import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage } from '../../scripts/harness/env.mjs';
const img = await loadImage('fixtures/page-forty.jpg');
const cut = (x, y, w, h, scale, path) => {
  const c = createCanvas(w * scale, h * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, x, y, w, h, 0, 0, w * scale, h * scale);
  writeFileSync(path, c.toBuffer('image/png'));
};
cut(292, 540, 190, 220, 4, '.dsh/tmp/blk8-zoom.png');
console.log('ok');
