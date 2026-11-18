import { loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
await prepareOrt();
const img = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(img, []);
const mask = detected.mask, S=1024;
const boxes = [
  { name: 'blk8-blue', x: 311, y: 581, width: 79, height: 156, lean: 5.0 },
  { name: 'blk8-right', x: 330, y: 581, width: 60, height: 156, lean: 5.0 },
  { name: 'blk7-blue', x: 177, y: 1033, width: 169, height: 358, lean: 15.5 },
  { name: 'blk7block', x: 202, y: 983, width: 146, height: 376, lean: 15.5 },
];
const pct = (arr, p) => arr[Math.min(arr.length-1, Math.max(0, Math.round((arr.length-1)*p)))];
for (const b of boxes) {
  const x0 = Math.max(0, Math.floor(b.x * mask.scale + mask.padX));
  const y0 = Math.max(0, Math.floor(b.y * mask.scale + mask.padY));
  const x1 = Math.min(S - 1, Math.ceil((b.x + b.width) * mask.scale + mask.padX));
  const y1 = Math.min(S - 1, Math.ceil((b.y + b.height) * mask.scale + mask.padY));
  const phi = b.lean * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const us=[], vs=[];
  for (let my=y0; my<=y1; my++) for (let mx=x0; mx<=x1; mx++) {
    if (mask.data[my*S+mx] < 0.3) continue;
    const x=(mx-mask.padX)/mask.scale, y=(my-mask.padY)/mask.scale;
    us.push(x*cos - y*sin); vs.push(x*sin + y*cos);
  }
  us.sort((a,b)=>a-b); vs.sort((a,b)=>a-b);
  console.log(b.name, 'n',us.length,
    'u5-95', (pct(us,.95)-pct(us,.05)).toFixed(1),
    'u10-90', (pct(us,.9)-pct(us,.1)).toFixed(1),
    'u25-75', (pct(us,.75)-pct(us,.25)).toFixed(1),
    'v10-90', (pct(vs,.9)-pct(vs,.1)).toFixed(1));
}
