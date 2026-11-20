import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage } from '../../scripts/harness/env.mjs';
const src = await loadImage('fixtures/page-forty.jpg');
const c = createCanvas(320, 560);
c.getContext('2d').drawImage(src, 160, 940, 320, 560, 0, 0, 320, 560);
writeFileSync('.dsh/tmp/banner-src.png', c.toBuffer('image/png'));
console.log('ok');
