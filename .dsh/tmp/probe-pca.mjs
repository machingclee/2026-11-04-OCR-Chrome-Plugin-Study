import { createCanvas, loadImage } from '../../scripts/harness/env.mjs';
const bitmap = await loadImage('fixtures/page-forty.jpg');
const c = createCanvas(bitmap.width, bitmap.height);
c.getContext('2d').drawImage(bitmap, 0, 0);
const x0 = 312, y0 = 582, w = 78, h = 155;
const data = c.getContext('2d').getImageData(x0, y0, w, h).data;
const pts = [];
for (let y = 0; y < h; y += 1) {
  for (let x = 0; x < w; x += 1) {
    const at = (y * w + x) * 4;
    const l = 0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2];
    if (l > 190) pts.push({ x: x0 + x, y: y0 + y });
  }
}
console.log('bright points', pts.length);
const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
let sxx = 0, syy = 0, sxy = 0;
for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
console.log('pca theta rad', theta, 'deg', theta * 180 / Math.PI, 'centre', mx.toFixed(1), my.toFixed(1));
console.log('eigen-ish', sxx / pts.length, syy / pts.length, sxy / pts.length);
