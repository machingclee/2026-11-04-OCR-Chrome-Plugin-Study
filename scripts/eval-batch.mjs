/**
 * Run a list of pages through the real pipeline and keep everything the fix
 * needs to be judged: the rendered page, the detection it came from, and the
 * per-group layout log.
 *
 *   npx esbuild scripts/eval-batch.mjs --bundle --platform=node --format=esm \
 *     --packages=external --outfile=out/eval-batch.bundle.mjs
 *   node out/eval-batch.bundle.mjs fixtures/page-t01.jpg fixtures/page-t02.jpg
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { readApiKey, prepareOrt } from './harness/env.mjs';
import { cacheableDetection, runPage } from './harness/page.mjs';

const OUT = resolve(process.cwd(), 'out/eval');
mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const effort = argv.includes('--effort') ? argv[argv.indexOf('--effort') + 1] : 'off';
const pages = argv.filter((value, at) => !value.startsWith('--') && argv[at - 1] !== '--effort');

await prepareOrt();
const key = readApiKey();
if (!key) throw new Error('No DeepSeek key.');

for (const pageArg of pages) {
    const page = resolve(process.cwd(), pageArg);
    const name = basename(page).replace(/\.[^.]+$/, '');
    const logPath = `${OUT}/${name}-log.txt`;
    const reportPath = `${OUT}/${name}-report.json`;
    const pngPath = `${OUT}/${name}.png`;
    const lines = [];
    const realInfo = console.info;
    const realWarn = console.warn;
    console.info = (...args) => { lines.push(args.map(String).join(' ')); realInfo(...args); };
    console.warn = (...args) => { lines.push(`WARN ${args.map(String).join(' ')}`); realWarn(...args); };
    try {
        const result = await runPage({ imagePath: page, key, effort });
        result.save(pngPath);
        if (result.erasedUrl) {
            writeFileSync(`${OUT}/${name}-erased.png`, Buffer.from(result.erasedUrl.slice(result.erasedUrl.indexOf(',') + 1), 'base64'));
        }
        writeFileSync(`${OUT}/${name}-det.json`, JSON.stringify(cacheableDetection(result.detection), null, 2));
        writeFileSync(reportPath, JSON.stringify({
            page,
            image: { width: result.imageWidth, height: result.imageHeight },
            eraseBoxes: result.eraseBoxes,
            groups: result.detection.groups.map((group) => ({
                lines: group.lines,
                translations: group.translations,
                fontSize: group.fontSize,
                vertical: group.vertical,
                balloon: group.balloon,
                glosses: group.glosses,
                frames: group.frames,
            })),
            items: result.job.items.map((item) => ({
                groupId: item.groupId,
                x: item.x, y: item.y, width: item.width, height: item.height,
                angle: item.angle, vertical: item.vertical, fontSize: item.fontSize,
                text: item.text,
            })),
            skipped: result.job.skipped,
        }, null, 2));
        lines.push(`RESULT ${name} groups ${result.detection.groups.length} items ${result.job.items.length}`);
        writeFileSync(logPath, lines.join('\n'));
    } catch (cause) {
        lines.push(`ERROR ${cause instanceof Error ? cause.stack : String(cause)}`);
        writeFileSync(logPath, lines.join('\n'));
        console.error(`[batch] ${name} failed:`, cause);
    } finally {
        console.info = realInfo;
        console.warn = realWarn;
    }
}
