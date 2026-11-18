import { readApiKey } from '../../scripts/harness/env.mjs';
import { translateGroups } from '../../src/lib/translationJob.ts';

const key = readApiKey();
const variants = [
  ['やっぱり', '熱いな…', 'このヒーローものは'],
  ['やっぱり', '熱いな…', 'ヒロインモノは'],
  ['やっぱり', '熱いな…', 'ヒロイモノ'],
];
for (const lines of variants) {
  const group = {
    x: 320, y: 580, width: 73, height: 135,
    lines, vertical: true,
  };
  const result = await translateGroups({
    groups: [group],
    boxes: [],
    balloons: [],
    imageWidth: 1126,
    imageHeight: 1600,
    settings: { translator: 'deepseek', deepSeekKey: key, effort: 'off' },
  });
  console.log(JSON.stringify(lines), '=>', JSON.stringify(result.answers[0]?.text), 'labels', JSON.stringify(result.items.map(i => i.text)));
}
