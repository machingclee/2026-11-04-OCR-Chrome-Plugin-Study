import { loadImage, prepareOrt } from '../../../scripts/harness/env.mjs';
import { detectLines } from '../../../src/lib/detect/index.ts';
await prepareOrt();
const img = await loadImage('fixtures/page-forty.jpg');
const d = await detectLines(img, []);
const m = d.mask, S=1024;
const y0=575, y1=740, x0=270, x1=312;
const prof=[];
for (let x=x0;x<=x1;x+=1) {
  let best=0;
  for (let y=y0;y<=y1;y+=1) {
    const mx=Math.round(x*m.scale+m.padX), my=Math.round(y*m.scale+m.padY);
    if (mx<0||my<0||mx>=S||my>=S) continue;
    const v=m.data[my*S+mx]; if(v>best)best=v;
  }
  prof.push([x,best]);
}
const run=prof.filter(([,v])=>v>=0.12).map(([x])=>x);
console.log('run', run.length?`${run[0]}-${run[run.length-1]}`:'none', 'profile', prof.filter(([x])=>x%4===0).map(([x,v])=>`${x}:${v.toFixed(2)}`).join(' '));
let minY=Infinity,maxY=-Infinity;
for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++) {
  const mx=Math.round(x*m.scale+m.padX), my=Math.round(y*m.scale+m.padY);
  if (mx<0||my<0||mx>=S||my>=S) continue;
  if (m.data[my*S+mx] < 0.12) continue;
  if (y<minY)minY=y; if(y>maxY)maxY=y;
}
console.log('y',minY,maxY);
