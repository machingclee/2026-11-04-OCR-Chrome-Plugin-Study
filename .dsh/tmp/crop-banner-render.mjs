import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage } from '../../scripts/harness/env.mjs';
const img = await loadImage('out/regression/incline.png');
const name = process.argv[2] ?? 'after';
const c = createCanvas(260, 460);
c.getContext('2d').drawImage(img, 150, 930, 260, 460, 0, 0, 260, 460);
writeFileSync(`docs/loops/assets/banner-${name}.png`, c.toBuffer('image/png'));
console.log(name, img.width, img.height);
