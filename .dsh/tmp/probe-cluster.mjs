import { loadImage, prepareOrt } from '../../scripts/harness/env.mjs';
import { detectLines } from '../../src/lib/detect/index.ts';
await prepareOrt();
const img = await loadImage('fixtures/page-forty.jpg');
const detected = await detectLines(img, []);
const mask = detected.mask, S=1024;
const boxes = [
  { name: 'blk8-blue', x: 311, y: 581, width: 79, height: 156, lean: 5.0 },
  { name: 'blk7-blue', x: 177, y: 1033, width: 169, height: 358, lean: 15.5 },
];
for (const b of boxes) {
  const x0 = Math.max(0, Math.floor(b.x * mask.scale + mask.padX));
  const y0 = Math.max(0, Math.floor(b.y * mask.scale + mask.padY));
  const x1 = Math.min(S - 1, Math.ceil((b.x + b.width) * mask.scale + mask.padX));
  const y1 = Math.min(S - 1, Math.ceil((b.y + b.height) * mask.scale + mask.padY));
  const phi = b.lean * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const vals=[];
  for (let my=y0; my<=y1; my++) for (let mx=x0; mx<=x1; mx++) {
    if (mask.data[my*S+mx] < 0.3) continue;
    const x=(mx-mask.padX)/mask.scale, y=(my-mask.padY)/mask.scale;
    vals.push(x*cos - y*sin);
  }
  vals.sort((a,b)=>a-b);
  const min=vals[0], max=vals[vals.length-1];
  const bin=4, nb=Math.ceil((max-min)/bin)+1;
  const hist=new Array(nb).fill(0);
  for(const v of vals) hist[Math.min(nb-1,Math.floor((v-min)/bin))]++;
  // print peaks
  const peaks=[];
  for(let i=1;i<nb-1;i++) if(hist[i]>=hist[i-1]&&hist[i]>=hist[i+1]&&hist[i]>vals.length*0.01) peaks.push([min+i*bin+bin/2,hist[i]]);
  peaks.sort((a,b)=>b[1]-a[1]);
  console.log(b.name,'n',vals.length,'range',min.toFixed(0),max.toFixed(0),'peaks',peaks.slice(0,6).map(p=>`${p[0].toFixed(0)}:${p[1]}`).join(' '));
}
