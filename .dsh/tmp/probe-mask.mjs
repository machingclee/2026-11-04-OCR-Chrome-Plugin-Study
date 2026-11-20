import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
import { MODEL_SIZE } from '../../src/lib/mask.ts';

await prepareOrt();
const bitmap = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(bitmap, []);
const mask = detected.mask;
console.log('mask scale', mask.scale, 'pad', mask.padX, mask.padY);
const box = { x: 312, y: 582, width: 78, height: 155 };
const x0 = Math.floor(box.x * mask.scale + mask.padX), y0 = Math.floor(box.y * mask.scale + mask.padY);
const x1 = Math.ceil((box.x + box.width) * mask.scale + mask.padX), y1 = Math.ceil((box.y + box.height) * mask.scale + mask.padY);
console.log('mask window', x0, y0, x1 - x0, y1 - y0);
const values = [];
for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) values.push(mask.data[y * MODEL_SIZE + x]);
values.sort((a, b) => b - a);
console.log('top mask values', values.slice(0, 20).map(v => v.toFixed(2)).join(' '));
console.log('above 0.2:', values.filter(v => v > 0.2).length, 'above 0.1:', values.filter(v => v > 0.1).length, 'total', values.length);
// ascii map of the window at 0.2 threshold
const c = createCanvas(bitmap.width, bitmap.height);
c.getContext('2d').drawImage(bitmap, 0, 0);
const canvas = createCanvas(x1 - x0, y1 - y0);
const ctx = canvas.getContext('2d');
const image = ctx.createImageData(x1 - x0, y1 - y0);
for (let y = 0; y < y1 - y0; y += 1) {
  for (let x = 0; x < x1 - x0; x += 1) {
    const v = mask.data[(y0 + y) * MODEL_SIZE + (x0 + x)];
    const at = (y * (x1 - x0) + x) * 4;
    const on = v > 0.2 ? 255 : 0;
    image.data[at] = on; image.data[at + 1] = v > 0.5 ? 255 : on; image.data[at + 2] = on; image.data[at + 3] = 255;
  }
}
ctx.putImageData(image, 0, 0);
const big = createCanvas((x1 - x0) * 8, (y1 - y0) * 8);
const bctx = big.getContext('2d');
bctx.imageSmoothingEnabled = false;
bctx.drawImage(canvas, 0, 0, big.width, big.height);
writeFileSync('.dsh/tmp/mask-window.png', big.toBuffer('image/png'));
