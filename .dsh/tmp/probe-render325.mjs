import { writeFileSync } from 'node:fs';
import { createCanvas, prepareOrt, readApiKey } from '../../scripts/harness/env.mjs';
import { runPage } from '../../scripts/harness/page.mjs';

await prepareOrt();
const key = readApiKey();
const page = await runPage({ imagePath: process.cwd() + '/fixtures/page-325.jpg', key, effort: 'off' });
console.log('items near the speech:');
for (const item of page.job.items) {
  if (item.x > 1000 || item.x + item.width < 850 || item.y > 600) continue;
  console.log(JSON.stringify({ text: item.text, x: +item.x.toFixed(0), y: +item.y.toFixed(0), w: +item.width.toFixed(0), h: +item.height.toFixed(0), font: item.fontSize, vertical: item.vertical }));
}
const crop = createCanvas(240, 320);
crop.getContext('2d').drawImage(page.canvas, 900, 110, 240, 320, 0, 0, 240, 320);
writeFileSync('.dsh/tmp/cup-render.png', crop.toBuffer('image/png'));
page.save('out/page-325-rendered.png');
