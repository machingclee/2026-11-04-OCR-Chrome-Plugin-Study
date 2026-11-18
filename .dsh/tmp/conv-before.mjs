import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage } from '../../scripts/harness/env.mjs';
const img = await loadImage(process.argv[2] ?? '.dsh/tmp/user-before.webp');
const c = createCanvas(img.width, img.height);
c.getContext('2d').drawImage(img, 0, 0);
writeFileSync('docs/loops/assets/font-before.png', c.toBuffer('image/png'));
console.log(img.width, img.height);
