import { loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
await prepareOrt();
const img = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(img, []);
const mask = detected.mask, S=1024;
const boxes = [
  { name: 'blk8', x: 311, y: 581, width: 79, height: 156, lean: 5.0, chars: 4 },
  { name: 'blk7', x: 177, y: 1033, width: 169, height: 358, lean: 15.5, chars: 7 },
  { name: 'blk7block', x: 202, y: 983, width: 146, height: 376, lean: 15.5, chars: 7 },
];
for (const b of boxes) {
  const x0 = Math.max(0, Math.floor(b.x * mask.scale + mask.padX));
  const y0 = Math.max(0, Math.floor(b.y * mask.scale + mask.padY));
  const x1 = Math.min(S - 1, Math.ceil((b.x + b.width) * mask.scale + mask.padX));
  const y1 = Math.min(S - 1, Math.ceil((b.y + b.height) * mask.scale + mask.padY));
  const phi = b.lean * Math.PI / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  let umin=Infinity,umax=-Infinity,vmin=Infinity,vmax=-Infinity,n=0;
  for (let my=y0; my<=y1; my++) for (let mx=x0; mx<=x1; mx++) {
    if (mask.data[my*S+mx] < 0.3) continue;
    const x=(mx-mask.padX)/mask.scale, y=(my-mask.padY)/mask.scale;
    const u = x*cos - y*sin;
    const v = x*sin + y*cos;
    if (u<umin) umin=u; if(u>umax)umax=u;
    if (v<vmin) vmin=v; if(v>vmax)vmax=v;
    n++;
  }
  console.log(b.name, 'n',n,'u', (umax-umin).toFixed(1), 'v',(vmax-vmin).toFixed(1), 'v/chars',((vmax-vmin)/b.chars).toFixed(1));
}
