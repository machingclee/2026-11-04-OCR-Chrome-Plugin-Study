import { loadImage, prepareOrt } from '../../../scripts/harness/env.mjs';
import { detectLines } from '../../../src/lib/detect/index.ts';
await prepareOrt();
const img = await loadImage('fixtures/page-forty.jpg');
const d = await detectLines(img, []);
for (const name of ['det','mask']) {
  const m = d[name];
  if (!m) { console.log(name,'none'); continue; }
  const S=1024;
  const x0=260, x1=405, y0=560, y1=740;
  const prof=[];
  for (let x=x0;x<=x1;x+=2) {
    let best=0, sum=0, n=0;
    for (let y=y0;y<=y1;y+=2) {
      const mx=Math.round(x*m.scale+m.padX), my=Math.round(y*m.scale+m.padY);
      if (mx<0||my<0||mx>=S||my>=S) continue;
      const v=m.data[my*S+mx]; if(v>best)best=v; sum+=v; n++;
    }
    prof.push(`${x}:${best.toFixed(2)}`);
  }
  console.log(name, prof.join(' '));
}
