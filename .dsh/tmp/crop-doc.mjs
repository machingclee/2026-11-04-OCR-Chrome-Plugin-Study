import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage } from '../../scripts/harness/env.mjs';
const img = await loadImage('out/regression/incline.png');
const c = createCanvas(240, 330);
const ctx = c.getContext('2d');
ctx.drawImage(img, 270, 520, 240, 330, 0, 0, 240, 330);
writeFileSync('docs/loops/assets/onnx-hint-after.png', c.toBuffer('image/png'));
console.log('ok');
