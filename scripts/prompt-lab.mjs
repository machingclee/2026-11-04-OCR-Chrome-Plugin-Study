/**
 * Compare translation prompts on one frozen detection.
 *
 *   node out/prompt-lab.bundle.mjs out/eval/det-320.json --effort off
 *
 * The reader returns slightly different cell boxes on every run, and a
 * different grouping changes the translation more than the prompt does. So the
 * detection is captured once (npm run render:page -- ... --save-detection) and
 * every variant is measured against that same page state.
 *
 * It prints one line per region: the source, the translation, and the columns
 * the model chose, each with its character count against the source column's.
 */
import { readFileSync } from 'node:fs';

import { SYSTEM_PROMPT, buildUserPrompt } from '../src/lib/translatePrompt.ts';
import { DEFAULT_REASONING_EFFORT } from '../src/shared/constants.ts';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-flash';

function readKey() {
    if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
    const text = readFileSync('.env', 'utf8');
    return (text.match(/^\s*(?:VITE_)?DEEPSEEK_API_KEY\s*=\s*(.*)$/m)?.[1] ?? '').trim().replace(/^['"]|['"]$/g, '');
}

async function ask(key, system, user, effort, temperature) {
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
            model: MODEL,
            temperature,
            response_format: { type: 'json_object' },
            ...(effort === 'off'
                ? { thinking: { type: 'disabled' } }
                : { thinking: { type: 'enabled' }, reasoning_effort: effort }),
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
        }),
    });
    if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
    const payload = await response.json();
    const usage = payload.usage ?? {};
    return {
        content: payload.choices?.[0]?.message?.content ?? '',
        completion: usage.completion_tokens ?? 0,
        reasoning: usage.completion_tokens_details?.reasoning_tokens ?? 0,
        ms: Date.now() - startedAt,
    };
}

/** Names that must survive the column split whole. */
const GLOSSARY = ['艾爾瑪', '艾薩斯', '瑪莉絲', '伯爵大人'];

let startedAt = Date.now();

function args() {
    const options = { file: null, effort: DEFAULT_REASONING_EFFORT, json: null, temperature: 0, only: null };
    const argv = process.argv.slice(2);
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--effort') options.effort = argv[++index];
        else if (value === '--json') options.json = argv[++index];
        else if (value === '--temperature') options.temperature = Number(argv[++index]);
        else if (value === '--only') options.only = argv[++index].split(',');
        else options.file = value;
    }
    if (!options.file) throw new Error('Usage: prompt-lab.mjs <detection.json> [--effort off|high] [--temperature t] [--only r1,r2]');
    return options;
}

const options = args();
const detection = JSON.parse(readFileSync(options.file, 'utf8'));
const key = readKey();
if (!key) throw new Error('No DeepSeek key in .env');

const groups = detection.groups;
const regions = groups.map((group, index) => ({
    id: `r${index + 1}`,
    direction: (group.vertical ?? (group.height > group.width * 1.3) ? 'v' : 'h'),
    lines: group.lines,
}));
const pageTexts = groups.map((group) => group.lines.join(''));
const system = SYSTEM_PROMPT;
const build = buildUserPrompt;

console.log(`[lab] ${options.file}, effort ${options.effort}, temperature ${options.temperature}, ${regions.length} region(s)`);
const results = [];
let totalContent = 0;
let totalReasoning = 0;
for (const [index, region] of regions.entries()) {
    if (options.only && !options.only.includes(region.id)) continue;
    const context = pageTexts.filter((_, other) => other !== index);
    startedAt = Date.now();
    let content = '';
    let usage = { completion: 0, reasoning: 0, ms: 0 };
    try {
        const answer = await ask(key, system, build([region], '繁體中文', context), options.effort, options.temperature);
        content = answer.content;
        usage = answer;
    } catch (cause) {
        console.log(`[error] ${region.id}: ${cause.message}`);
        results.push({ id: region.id, source: region.lines, error: String(cause) });
        continue;
    }
    totalContent += usage.completion;
    totalReasoning += usage.reasoning;
    let parsed = null;
    try {
        parsed = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
    } catch {
        console.log(`[raw ] ${region.id}: ${content.slice(0, 300)}`);
    }
    const item = parsed?.regions?.[0] ?? {};
    const columns = Array.isArray(item.columns) ? item.columns : [];
    const sourceColumns = region.lines;
    const fit = columns.map((column, at) => `${[...column].length}/${[...(sourceColumns[at] ?? '')].length}`).join(' ');
    // Two things the page asked for that can be counted, not judged: a column
    // longer than its source column plus one (it will be shrunk to fit), and a
    // name cut across two columns (「艾爾」+「瑪」).
    const overflow = columns.filter((column, at) => [...column].length > [...(sourceColumns[at] ?? '')].length + 1).length;
    const cutNames = GLOSSARY.filter((name) => {
        if (!columns.join('').includes(name)) return false;
        return !columns.some((column) => column.includes(name));
    });
    console.log(`\n[${region.id}] ${JSON.stringify(sourceColumns)} cost ${usage.completion}t/${usage.reasoning}r ${usage.ms}ms`);
    console.log(`   type=${item.type} translation=${JSON.stringify(item.translation)}`);
    console.log(`   columns(${columns.length}/${sourceColumns.length}) ${JSON.stringify(columns)} fit ${fit}`
        + `${overflow > 0 ? ` OVERFLOW ${overflow}` : ''}${cutNames.length > 0 ? ` CUT ${cutNames.join(',')}` : ''}`);
    results.push({ id: region.id, source: region.lines, item, columns, fit, overflow, cutNames, usage });
}
const overflowed = results.filter((entry) => entry.overflow > 0).length;
const cut = results.filter((entry) => (entry.cutNames ?? []).length > 0).length;
console.log(`\n[lab] tokens: ${totalContent} completion, ${totalReasoning} reasoning, `
    + `${results.length} region(s), ${overflowed} with an overflowing column, ${cut} with a cut name`);
if (options.json) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(options.json, `${JSON.stringify(results, null, 2)}\n`);
}
