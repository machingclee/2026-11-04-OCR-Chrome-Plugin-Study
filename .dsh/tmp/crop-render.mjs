import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage } from '../../scripts/harness/env.mjs';
const img = await loadImage('out/regression/incline.png');
console.log(img.width, img.height);
const c = createCanvas(150 * 4, 260 * 4);
const ctx = c.getContext('2d');
ctx.imageSmoothingEnabled = false;
ctx.drawImage(img, 280, 540, 150, 260, 0, 0, c.width, c.height);
writeFileSync('.dsh/tmp/render-speech.png', c.toBuffer('image/png'));
