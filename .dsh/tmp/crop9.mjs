import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage } from '../../scripts/harness/env.mjs';
const img = await loadImage('fixtures/page-forty.jpg');
const c = createCanvas(110 * 7, 175 * 7);
const ctx = c.getContext('2d');
ctx.imageSmoothingEnabled = false;
ctx.drawImage(img, 310, 575, 110, 175, 0, 0, c.width, c.height);
writeFileSync('.dsh/tmp/blk8-zoom7.png', c.toBuffer('image/png'));
console.log(c.width, c.height);
