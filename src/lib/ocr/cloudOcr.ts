import type { BoxData, OcrRequest } from '../../shared/types';
import type { ReasoningEffort } from '../../shared/constants';
import { foldAngle } from '../rect';
import type { OcrResult, TextLine } from '../types';
import { cropSize, drawUpright } from '../warp';
import { blockCropBox, blockCropDataUrl } from './blockCrop';
import { cellToPage, gridGeometry } from './grid';
import { recognizeLine } from './recognize';

/**
 * Cloud reading.
 *
 * The detector owns the geometry, so the cloud model never has to find a line.
 * Each detected line goes to the model as one upright crop, in reading order,
 * and comes back as text. A line the model leaves blank falls back to the
 * on-device recogniser, so a failed request or an empty answer degrades to the
 * old behaviour instead of losing the line.
 */

/** How many single-crop requests run at once. */
const CONCURRENCY = 6;
/**
 * The cloud is asked only about lines the device reads below this confidence,
 * which is the same floor that decides whether a line is translated at all.
 */
const ASSIST_BELOW = 0.7;
/** Wait before one retry, so a burst limit does not lose a line. */
const RETRY_DELAY_MS = 1400;
/** Smallest crop height, in pixels. A thin column is upscaled toward this. */
const TARGET_THICKNESS = 64;
/** A crop is capped here so one long column cannot dominate a request. */
const MAX_CROP_SIDE = 1600;
const JPEG_QUALITY = 0.92;
const REQUEST_TIMEOUT_MS = 60_000;

const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-flash';

const TRANSCRIBE_PROMPT = [
    'The image is a crop of a Japanese comic, shown in the orientation it has on the page.',
    'A crop usually holds one text line. Vertical Japanese reads top to bottom with the columns running right to left; horizontal Japanese reads left to right, top to bottom.',
    'A crop can hold several parallel text lines when one detection box covered more than one column. Report each one separately, in reading order.',
    'Transcribe the text exactly as printed.',
    'Keep small kana (っ ゃ ゅ ょ ぁ ぃ ぅ ぇ ぉ ー), dakuten and handakuten, punctuation (、。「」『』…！？), Latin letters, digits and symbols.',
    'Do not translate, do not explain, do not add spaces, and do not convert full-width characters to half-width or the reverse.',
    'Never complete a word from context: transcribe only the glyphs that are visible.',
    'row is the 1-based position of the line in reading order. columns is the number of parallel character columns that line itself holds, which is 1 for a normal line.',
    'Return JSON only: {"lines":[{"row":1,"columns":1,"text":"…"}]}',
].join(' ');

export type CloudReading = {
    lines: BoxData[];
    provider: string;
    /** Lines the device read, including every line the cloud was not asked about. */
    fallbacks: number;
    /** Lines the cloud actually supplied text for. */
    cloudLines: number;
};

/**
 * One line as a JPEG data URL, in the orientation it has on the page.
 *
 * The on-device recogniser wants the column turned a quarter turn, because it
 * was trained that way. A general vision model does not: it reads vertical
 * Japanese as printed, and a quarter turn rotates every glyph, which is what a
 * misread looks like. So the crop keeps the page orientation, and the prompt
 * says which way to read it.
 */
function cropToDataUrl(bitmap: ImageBitmap, line: TextLine): string {
    const size = cropSize(line);
    const upright = document.createElement('canvas');
    upright.width = Math.max(1, Math.round(size.width));
    upright.height = Math.max(1, Math.round(size.height));
    const uprightContext = upright.getContext('2d');
    if (!uprightContext) throw new Error('The browser refused a 2D context for a cloud crop.');
    drawUpright(uprightContext, bitmap, line, upright.width, upright.height);

    const vertical = line.direction === 'vertical';
    const thickness = vertical ? upright.width : upright.height;
    const upscale = Math.min(3, Math.max(1, TARGET_THICKNESS / Math.max(1, thickness)));
    const downscale = MAX_CROP_SIDE / Math.max(upright.width, upright.height);
    const scale = Math.min(upscale, downscale);
    const width = Math.max(1, Math.round(upright.width * scale));
    const height = Math.max(1, Math.round(upright.height * scale));

    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const context = out.getContext('2d');
    if (!context) throw new Error('The browser refused a 2D context for a cloud crop.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, out.width, out.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(upright, 0, 0, width, height);
    return out.toDataURL('image/jpeg', JPEG_QUALITY);
}

/** The effort the popup chose, as the request body spells it. */
function thinkingOf(effort: ReasoningEffort): Record<string, unknown> {
    // The API maps every level onto low, high or max, and thinks at high by
    // default, so these are the only three it can act on. Off turns the chain
    // of thought away for a fast pass.
    if (effort === 'off') return { thinking: { type: 'disabled' } };
    return { thinking: { type: 'enabled' }, reasoning_effort: effort };
}

function deepSeekBody(dataUrls: string[], prompt: string, effort: ReasoningEffort): Record<string, unknown> {
    const content: Record<string, unknown>[] = [{ type: 'text', text: prompt }];
    dataUrls.forEach((dataUrl) => {
        content.push({ type: 'image_url', image_url: { url: dataUrl } });
    });
    return {
        model: DEEPSEEK_MODEL,
        // One call does the transcription, the layout and the translation, so it
        // gets the effort the translation needs. Reading glyphs alone would not
        // justify a chain of thought; deciding the columns, the type and the
        // Chinese wording in the same pass does.
        ...thinkingOf(effort),
        messages: [
            { role: 'system', content: 'You read Japanese comic pages: you transcribe the text and describe where each line sits. You never translate; a separate request does that.' },
            { role: 'user', content },
        ],
    };
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
        response = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
        });
    } catch (cause) {
        if (controller.signal.aborted) throw new Error('The cloud reader did not answer within a minute.');
        throw cause;
    } finally {
        clearTimeout(timer);
    }
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const error = new Error(`The cloud reader answered ${response.status}. ${detail.slice(0, 160)}`);
        (error as Error & { status?: number }).status = response.status;
        throw error;
    }
    return response.text();
}

function extractJson(content: string): string {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return fenced[1].trim();
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start < 0 || end <= start) return content.trim();
    return content.slice(start, end + 1).trim();
}

/**
 * Guard against an answer produced without the images. A provider that read the
 * crops charges hundreds of input tokens for each one; an answer billed at the
 * prompt price means the images never arrived, and the text is invented.
 */
function assertImagesRead(tokens: unknown, images: number, provider: string): void {
    if (typeof tokens !== 'number' || tokens <= 0 || images === 0) return;
    // The prompt alone is a few hundred tokens, and one crop is at least a
    // hundred more. An answer below this floor was produced without the crops,
    // and its text is invented.
    const floor = 250 + images * 80;
    console.info(`[cloud-ocr] ${provider}: ${images} crops, ${tokens} input tokens (floor ${floor})`);
    if (tokens < floor) {
        throw new Error(
            `The ${provider} model answered with ${tokens} input tokens for ${images} crops, so it never read the images.`,
        );
    }
}

export type CloudLine = {
    /** 1-based position of the text line inside the crop, top to bottom. */
    row: number;
    /** Parallel character columns that line holds. One for a normal line. */
    columns: number;
    text: string;
};

/** The text lines of one crop, in reading order. */
function readReadings(content: string): CloudLine[] {
    const parsed = JSON.parse(extractJson(content)) as {
        lines?: { row?: unknown; columns?: unknown; text?: unknown }[];
        results?: { row?: unknown; columns?: unknown; text?: unknown }[];
        text?: unknown;
    };
    const list = parsed.lines ?? parsed.results;
    if (!Array.isArray(list)) {
        // A model that ignores the shape can still return one plain text.
        const plain = typeof parsed.text === 'string' ? parsed.text.trim() : '';
        if (plain.length === 0) throw new Error('The cloud reader returned no lines array.');
        return [{ row: 1, columns: 1, text: plain }];
    }
    const readings: CloudLine[] = [];
    for (const item of list) {
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        if (text.length === 0) continue;
        const row = Number(item.row);
        const columns = Number(item.columns);
        readings.push({
            row: Number.isInteger(row) && row > 0 ? row : readings.length + 1,
            columns: Number.isFinite(columns) && columns >= 1 ? Math.round(columns) : 1,
            text,
        });
    }
    return readings.sort((left, right) => left.row - right.row).slice(0, 4);
}

function deepSeekContent(payload: unknown): string {
    const body = payload as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content ?? '';
}

function deepSeekInputTokens(payload: unknown): unknown {
    const body = payload as { usage?: { prompt_tokens?: number } };
    return body.usage?.prompt_tokens;
}

async function deepSeekContentForSync(
    key: string,
    dataUrls: string[],
    prompt: string,
    effort: ReasoningEffort,
): Promise<string> {
    const raw = await post(DEEPSEEK_ENDPOINT, { Authorization: `Bearer ${key}` }, deepSeekBody(dataUrls, prompt, effort));
    const payload = JSON.parse(raw);
    assertImagesRead(deepSeekInputTokens(payload), dataUrls.length, 'deepseek');
    const usage = payload.usage as { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | undefined;
    console.info(`[read] deepseek effort ${effort}, tokens ${usage?.completion_tokens ?? '?'}, `
        + `reasoning ${usage?.completion_tokens_details?.reasoning_tokens ?? 0}`);
    return deepSeekContent(payload);
}

/** Reading is perception: it never thinks, and it is never the slow part. */
const READ_EFFORT: ReasoningEffort = 'off';

export async function requestDeepSeek(
    key: string,
    dataUrls: string[],
    effort: ReasoningEffort = READ_EFFORT,
): Promise<CloudLine[]> {
    return readReadings(await deepSeekContentForSync(key, dataUrls, TRANSCRIBE_PROMPT, effort));
}

/**
 * Read one line, with one retry. A single crop per request means the answer can
 * only be about this line: there is no index to map, and no way for a model to
 * pair a transcription with a different crop.
 */
async function readOneCrop(
    request: (key: string, dataUrls: string[], effort: ReasoningEffort) => Promise<CloudLine[]>,
    key: string,
    dataUrl: string,
    effort: ReasoningEffort,
): Promise<CloudLine[] | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            return await request(key, [dataUrl], effort);
        } catch (cause) {
            if (attempt === 0) {
                await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
                continue;
            }
            console.warn('Cloud reading failed for one line, reading it on device.', cause);
            return null;
        }
    }
    return null;
}

/**
 * Read every line with a multimodal model, one crop per request. A request that
 * fails, and a line the model leaves blank, fall back to the on-device model for
 * that line only.
 */
export async function recognizeLinesInCloud(
    bitmap: ImageBitmap,
    lines: TextLine[],
    ocr: OcrRequest,
): Promise<CloudReading> {
    if (lines.length === 0) return { lines: [], provider: ocr.provider, fallbacks: 0, cloudLines: 0 };

    // Every line is read on device first. A confident device reading is never
    // replaced by a cloud one, because a general vision model misreads printed
    // manga more often than the recogniser trained for it.
    const local: OcrResult[] = [];
    for (const line of lines) {
        local.push(await recognizeLine(bitmap, line, line.direction === 'vertical')
            .catch(() => ({ text: '', confidence: 0 })));
    }
    const doubtful: number[] = [];
    lines.forEach((_, index) => {
        const text = local[index].text.trim();
        if (text.length === 0 || local[index].confidence < ASSIST_BELOW) doubtful.push(index);
    });
    const collected: BoxData[] = lines.map((line, index) => ({
        ...line,
        text: local[index].text,
        confidence: local[index].confidence,
    }));
    if (doubtful.length === 0) {
        return { lines: collected, provider: ocr.provider, fallbacks: lines.length, cloudLines: 0 };
    }

    const crops = new Map<number, string>();
    try {
        for (const index of doubtful) crops.set(index, cropToDataUrl(bitmap, lines[index]));
    } catch (cause) {
        console.warn('Cloud reading could not cut the crops, keeping the device reading.', cause);
        return { lines: collected, provider: 'local', fallbacks: lines.length, cloudLines: 0 };
    }

    const readings = new Map<number, CloudLine[]>();
    const request = requestDeepSeek;
    const effort = READ_EFFORT;
    const queue = [...crops.keys()];
    let next = 0;
    const worker = async (): Promise<void> => {
        while (true) {
            const cursor = next;
            next += 1;
            if (cursor >= queue.length) return;
            const index = queue[cursor];
            const found = await readOneCrop(request, ocr.key, crops.get(index) as string, effort);
            if (found && found.length > 0) readings.set(index, found);
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()),
    );

    const out: BoxData[] = [];
    let cloudLines = 0;
    for (let index = 0; index < lines.length; index += 1) {
        const parts = readings.get(index);
        if (!parts) {
            out.push(collected[index]);
            continue;
        }
        cloudLines += 1;
        if (parts.length === 1) {
            out.push({ ...lines[index], text: parts[0].text, confidence: 1 });
            continue;
        }
        // One box covered several text lines. The model reported how many, so
        // the box is cut and each piece carries its own reading; the translation
        // can then go back column by column.
        const pieces = splitLineInBox(lines[index], parts.length);
        if (pieces.length !== parts.length) {
            out.push({ ...lines[index], text: parts[0].text, confidence: 1 });
            continue;
        }
        pieces.forEach((piece, partIndex) => {
            out.push({ ...piece, text: parts[partIndex].text, confidence: 1 });
        });
    }
    return { lines: out, provider: ocr.provider, fallbacks: lines.length - cloudLines, cloudLines };
}

/**
 * Cut one box into the number of text lines the model found. A vertical column
 * is cut across x and returned right to left, which is the manga reading order,
 * so the first returned piece matches the first text line the model reported.
 * A leaned line is left whole: its page box is not the box it is drawn from.
 */
export function splitLineInBox<T extends TextLine>(line: T, count: number): T[] {
    if (count < 2 || Math.abs(line.angle ?? 0) >= 0.01) return [line];
    const vertical = line.direction === 'vertical';
    const thickness = vertical ? line.width : line.height;
    // A piece has to be able to hold a column, or the cut is not believable.
    const most = Math.max(1, Math.min(4, count, Math.floor(thickness / 12)));
    if (most < 2) return [line];
    const step = thickness / most;
    const pieces: T[] = [];
    for (let index = 0; index < most; index += 1) {
        const offset = vertical
            ? line.x + thickness - step * (index + 1)
            : line.y + step * index;
        const piece = vertical
            ? { ...line, x: offset, width: step }
            : { ...line, y: offset, height: step };
        const centreOf = (ruby: { x: number; y: number; width: number; height: number }): number =>
            vertical ? ruby.x + ruby.width / 2 : ruby.y + ruby.height / 2;
        piece.ruby = (line.ruby ?? []).filter((ruby) => {
            const centre = centreOf(ruby);
            return centre >= offset && centre <= offset + step;
        });
        pieces.push(piece);
    }
    return pieces;
}

/** A region the model found inside one block, in page pixels. */
export type BlockRegion = {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    direction: 'v' | 'h';
    /** Parallel vertical columns the region holds. One for a single column. */
    columns: number;
    /** Horizontal rows the region holds. One for a single row. */
    rows: number;
    /** The box the reader read off the grid, in cells, when it gave one. */
    cells?: { x: number; y: number; width: number; height: number };
    /** Size of one glyph of this line, in page pixels. Undefined when unknown. */
    glyphSize?: number;
    /** The same line in Traditional Chinese, written in the reading call. */
    translation?: string;
    /** Dialogue or sound effect. */
    kind: 'chat' | 'sfx';
    /** Furigana the model saw on this line. Kept for inspection, never merged. */
    ruby?: string;
    /** Lean of the text axis in radians, as the rest of the pipeline stores it. */
    angle?: number;
    /** Length of the line along that axis, for an inclined line. */
    lineLength?: number;
    /** Thickness across that axis, for an inclined line. */
    lineThickness?: number;
};

export type BlockReading = {
    block: { x: number; y: number; width: number; height: number; score: number };
    regions: BlockRegion[];
    /** Page pixels per cell of the grid drawn on the crop. */
    cell: number;
    /** The detector's line boxes that were drawn in blue on this crop. */
    boxes: { x: number; y: number; width: number; height: number }[];
    /** The answer as the model sent it, for the debug view. */
    raw?: string;
    /** The crop the model saw, as a data URL. */
    cropUrl?: string;
};

/**
 * The answer shape, in one place. The prompt's example is generated from this
 * object, because a hand written example drifted from the parser twice: the
 * model follows whatever the example shows, so a missing field there is a field
 * it never returns.
 *
 * The box is in cells of the grid drawn on the crop, not a fraction of it: a
 * fraction is a measurement out of thin air, while a cell is a line the model
 * can see and a number it can read off the edge of the image.
 */
const REGION_EXAMPLE = {
    text: '…',
    type: 'chat',
    direction: 'v',
    // A vertical line of six characters: two cells across for the character,
    // twelve cells down the run.
    x: 4,
    y: 1,
    width: 2,
    height: 12,
};

const BLOCK_EXAMPLE = { regions: [REGION_EXAMPLE] };

const BLOCK_PROMPT = [
    'The image is a crop of one region of a Japanese comic page: a speech balloon, a caption, or a sound effect.',
    'Report one entry per text line, in reading order. A vertical column is one entry, a horizontal row is one entry. Never merge two columns or two rows into one entry, even when they form one sentence: each entry carries only the characters printed in its own column.',
    'One entry is one run of characters printed at one size. If a block mixes sizes, split it by size, not by row: a name box printed as a small 修士1年 followed by a large 有留木 円 is two entries, each with its own box, and a large heading above a small caption is two entries for the same reason.',
    'Furigana is not text. The small kana printed beside or above kanji to show how it is read are never an entry, never part of text, never a box, and never a field of their own. The test is size: furigana characters are clearly smaller than the characters of the line they belong to, so a small column sitting inside or beside a large column is a reading, and the entry is the large characters only.',
    'Blue rectangles mark the text of this block, as the detector found it. Text inside a blue rectangle is the only text to read: report those lines. Anything outside every blue rectangle is artwork or handwriting, so it is not a line, never goes into text, and never has an entry of its own. A formula, a scribbled number, an arrow or a signature drawn by hand is ignored completely, even when it runs beside a column or through the gap between columns. A column stays inside its own blue rectangle.',
    'text: exactly as printed, with small kana, dakuten, punctuation, Latin letters and digits. Never complete a word from context.',
    'Do not translate: this answer is read only. A separate request translates the text once the whole block has been read.',
    'A grid is drawn over the image, and every line of it carries a number: thin lines mark single cells, a thicker line marks every fifth. The numbers along the top edge are blue and count x, the numbers along the left edge are red and count y, both from 0 at the top left corner. Read the number on the line nearest the edge you are reporting instead of estimating a position between two lines.',
    'A reading can sit inside a blue rectangle, in the gap between the large characters and the box edge. It is still not a line: the entry covers the large characters, its box stays on the large characters, and the reading is left out of text. Never report it in any field. Small kana that belong to the word itself, such as the っ in いって, are part of the word and stay.',
    'type: "chat" for dialogue, including a short はい, うん, ええ, そう, ああ, いえ, いや and a line that starts with an ellipsis. "sfx" for onomatopoeia and sound effects such as ドドド, ゴゴゴ, ザワザワ, ドン, バン, ガシャ.',
    'direction: "v" when the line reads top to bottom, "h" when it reads left to right, "i" when the line is inclined.',
    'angle: for an inclined line, the angle of the text direction in degrees from the horizontal axis, clockwise on the image, between -89 and 89. Omit it for upright text.',
    'x and y: the cell holding the top left corner of the line, counted from the left edge and from the top edge of the image, both from 0. width and height: the size of the box in cells.',
    'The box is tight around that line. For a vertical line width is how wide one character is and height is how far the line runs; for a horizontal line height is one character and width is how far it runs. A character takes as many cells across as it does down, so a line of six characters written two cells wide is twelve cells tall, and a line of seven one cell characters that starts at row 2 ends at row 9.',
    'Read the numbers on the grid instead of guessing: a line whose left edge sits just past the line numbered 15 has x 16, and a box that starts just under the line numbered 10 has y 11. Every number is a whole cell: x, y, width and height are integers, so an edge between two lines takes the nearer line.',
    `Skip artwork with no text. Return JSON only: ${JSON.stringify(BLOCK_EXAMPLE)}`,
].join(' ');

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

/** One block as the image the reader is given: crop, upscale, grid, text boxes. */
function blockToDataUrl(
    bitmap: ImageBitmap,
    block: BlockReading['block'],
    boxes: { x: number; y: number; width: number; height: number }[],
): string {
    return blockCropDataUrl(bitmap, bitmap.width, bitmap.height, block, boxes).dataUrl;
}

/** Split one region the model reported as holding several lines. */
function splitRegion(region: BlockRegion): BlockRegion[] {
    const count = Math.max(1, region.columns > 1 ? region.columns : region.rows);
    if (count < 2) return [region];
    const vertical = region.columns > 1;
    const thickness = vertical ? region.width : region.height;
    if (thickness / count < 10) return [region];
    const step = thickness / count;
    const pieces: BlockRegion[] = [];
    for (let index = 0; index < count; index += 1) {
        const offset = vertical
            ? region.x + thickness - step * (index + 1)
            : region.y + step * index;
        // Each piece is one column of the entry it came from, so the cell box
        // that described the whole entry no longer applies to it.
        pieces.push(vertical
            ? { ...region, x: offset, width: step, columns: 1, rows: 1, cells: undefined }
            : { ...region, y: offset, height: step, columns: 1, rows: 1, cells: undefined });
    }
    return pieces;
}

/** Kana, the script a short companion line is usually written in. */
const KANA_ONLY = /^[\u3040-\u309F\u30A0-\u30FF\u30FC\u30FB]+$/u;

/**
 * Drop a reading that the reader reported as a line of its own.
 *
 * Furigana printed beside a kanji column sits inside that column's box, is only
 * kana, and is narrower than the column. The prompt says it is not text, but a
 * reader still returns it now and then, and a line that is a reading then gets
 * its own translation — which is how one sentence came back as two identical
 * columns. A reading printed beside its column is dropped too, when its kana
 * are clearly smaller than the column's characters: わたしたち beside 人類 came
 * back as a fourth line and got a fourth label. A same-size kana column beside
 * a box is dialogue and is folded in by `mergeCompanionRegions` instead.
 */
export function dropReadingsInsideColumns(regions: BlockRegion[]): BlockRegion[] {
    if (regions.length < 2) return regions;
    const thickness = (region: BlockRegion): number => (
        region.direction === 'v' ? region.width : region.height
    );
    const spanAcross = (region: BlockRegion): [number, number] => (
        region.direction === 'v'
            ? [region.x, region.x + region.width]
            : [region.y, region.y + region.height]
    );
    const spanAlong = (region: BlockRegion): [number, number] => (
        region.direction === 'v'
            ? [region.y, region.y + region.height]
            : [region.x, region.x + region.width]
    );
    const glyphs = (region: BlockRegion): number => (
        // Punctuation and brackets take a cell of the run as well.
        [...region.text.replace(/\s/gu, '')].length
    );
    // Length along the line per character. Furigana packs several kana beside
    // one or two kanji, so its advance is a fraction of the host's even when
    // the reader gives both boxes the same width in whole cells.
    const advance = (region: BlockRegion): number => {
        const [from, to] = spanAlong(region);
        return (to - from) / Math.max(1, glyphs(region));
    };
    const widest = Math.max(...regions.map(thickness));
    if (!(widest > 0)) return regions;
    return regions.filter((region) => {
        const text = region.text.replace(/[\s、。！？…「」『』]/gu, '');
        if (!(text.length > 0 && text.length <= 8 && KANA_ONLY.test(text))) return true;
        return !regions.some((host) => {
            if (host === region) return false;
            if (host.direction !== region.direction) return false;
            if (thickness(region) > thickness(host)) return false;
            const [hostFrom, hostTo] = spanAlong(host);
            const [from, to] = spanAlong(region);
            const overlap = Math.min(hostTo, to) - Math.max(hostFrom, from);
            if (overlap < (to - from) * 0.5) return false;
            const [hostStart, hostEnd] = spanAcross(host);
            const [ownStart, ownEnd] = spanAcross(region);
            // A reading inside the column's own band, clearly thinner than it.
            if (ownStart >= hostStart - 1 && ownEnd <= hostEnd + 1
                && thickness(region) <= widest * 0.7
                && thickness(host) >= thickness(region) * 1.5) {
                return true;
            }
            // A reading beside the column: within one host width of its edge,
            // and printed at a clearly smaller size. A same-size kana column
            // there is dialogue, which mergeCompanionRegions folds in instead.
            const gap = Math.max(hostStart - ownEnd, ownStart - hostEnd, 0);
            if (gap > thickness(host)) return false;
            if (glyphs(host) < 2 || glyphs(region) < 2) return false;
            return advance(region) <= advance(host) * 0.75;
        });
    });
}

/**
 * Fold a short companion line into the line it belongs to.
 *
 * A narrow column beside a wide one is often not furigana but a fragment of the
 * same speech: a quote, an answer, a trailing word. Dropping it loses text and
 * translating it on its own splits one sentence in two, so it is folded into its
 * neighbour instead: the text joins that line and the box grows to cover both.
 */
export function mergeCompanionRegions(regions: BlockRegion[]): BlockRegion[] {
    if (regions.length < 2) return regions;
    const thickness = (region: BlockRegion): number => (
        region.direction === 'v' ? region.width : region.height
    );
    const widest = Math.max(...regions.map(thickness));
    if (!(widest > 0)) return regions;

    // Only a reading is that much thinner than the line it belongs to. A kana
    // column at two thirds of the width is a line of its own, and folding it in
    // would change the meaning of the label it lands on.
    const hosts = regions.filter((region) => thickness(region) >= widest * 0.55);
    if (hosts.length === 0) return regions;
    const companions = regions.filter((region) => thickness(region) < widest * 0.55);
    if (companions.length === 0) return regions;

    const merged = hosts.map((host) => ({ ...host }));
    for (const companion of companions) {
        const text = companion.text.replace(/[\s、。！？…「」『』]/gu, '');
        // A reading is short as well as thin; a long kana column is dialogue.
        const kana = text.length > 0 && text.length <= 6 && KANA_ONLY.test(text);
        // A short kana line beside a wide one is a companion; a short line with
        // kanji is a line of its own, so it is left where it is.
        if (!kana) {
            merged.push({ ...companion });
            continue;
        }
        const cross = (region: BlockRegion): number => (
            region.direction === 'v' ? region.x + region.width / 2 : region.y + region.height / 2
        );
        let host = merged[0];
        let best = Number.POSITIVE_INFINITY;
        for (const candidate of merged) {
            if (candidate.direction !== companion.direction) continue;
            const distance = Math.abs(cross(candidate) - cross(companion));
            if (distance < best) {
                best = distance;
                host = candidate;
            }
        }
        const along = (region: BlockRegion): { start: number; end: number } => (
            region.direction === 'v'
                ? { start: region.y, end: region.y + region.height }
                : { start: region.x, end: region.x + region.width }
        );
        const hostSpan = along(host);
        const companionSpan = along(companion);
        const overlap = Math.min(hostSpan.end, companionSpan.end) - Math.max(hostSpan.start, companionSpan.start);
        if (overlap <= (companionSpan.end - companionSpan.start) * 0.2) {
            merged.push({ ...companion });
            continue;
        }
        // Vertical columns read right to left, so a companion to the right comes
        // first; a horizontal row reads left to right, so one above comes first.
        const before = companion.direction === 'v' ? cross(companion) > cross(host) : cross(companion) < cross(host);
        host.text = before ? `${companion.text}${host.text}` : `${host.text}${companion.text}`;
        const left = Math.min(host.x, companion.x);
        const top = Math.min(host.y, companion.y);
        const right = Math.max(host.x + host.width, companion.x + companion.width);
        const bottom = Math.max(host.y + host.height, companion.y + companion.height);
        host.x = left;
        host.y = top;
        host.width = right - left;
        host.height = bottom - top;
    }
    return merged;
}

/**
 * Keep two lines of one block from covering the same space. The reader is asked
 * not to overlap them, but when it does, the boundary between two neighbouring
 * columns is arithmetic: whichever starts first yields.
 */
export function separateOverlaps(regions: BlockRegion[]): BlockRegion[] {
    const vertical = regions.filter((region) => region.direction === 'v').sort((left, right) => left.x - right.x);
    for (let index = 1; index < vertical.length; index += 1) {
        const left = vertical[index - 1];
        const right = vertical[index];
        if (right.x > left.x && right.x < left.x + left.width) {
            left.width = Math.max(4, right.x - left.x);
        }
    }
    const horizontal = regions.filter((region) => region.direction === 'h').sort((left, right) => left.y - right.y);
    for (let index = 1; index < horizontal.length; index += 1) {
        const top = horizontal[index - 1];
        const bottom = horizontal[index];
        if (bottom.y > top.y && bottom.y < top.y + top.height) {
            top.height = Math.max(4, bottom.y - top.y);
        }
    }
    return regions;
}

/** Read the regions of one block and map their cell boxes to page pixels. */
function readBlockAnswer(content: string, crop: BlockReading['block']): BlockRegion[] {
    const parsed = JSON.parse(extractJson(content)) as {
        regions?: { text?: unknown; type?: unknown; kind?: unknown; ruby?: unknown; direction?: unknown; columns?: unknown; rows?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown; left?: unknown; top?: unknown; angle?: unknown }[];
        lines?: unknown;
    };
    const items = Array.isArray(parsed.regions) ? parsed.regions : [];
    if (items.length === 0) return [];
    const geometry = gridGeometry(crop);
    const regions: BlockRegion[] = [];
    for (const item of items) {
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        if (text.length === 0) continue;
        const chars = Math.max(1, [...text].length);
        const degrees = Number(item.angle);
        const axis = Number.isFinite(degrees)
            ? Math.max(-89, Math.min(89, degrees)) * Math.PI / 180
            : 0;
        const inclined = item.direction === 'i' || Math.abs(degrees) >= 12;
        // The answer is in cells of the grid drawn on the crop, so the box is a
        // multiplication away from page pixels. A fraction answer is still
        // accepted, for a model that ignores the grid.
        const cells = [item.x, item.y, item.width, item.height].map(Number);
        const fractions = [item.left, item.top, item.width, item.height].map(Number);
        let x: number;
        let y: number;
        let regionWidth: number;
        let regionHeight: number;
        let cellBox: { x: number; y: number; width: number; height: number } | undefined;
        if (cells.every((value) => Number.isFinite(value)) && cells[2] > 0 && cells[3] > 0) {
            // Whole cells only: a half the model sends anyway is rounded to the
            // nearer line, so a box always starts on a grid line.
            for (let axis = 0; axis < cells.length; axis += 1) cells[axis] = Math.round(cells[axis]);
            // A cell outside the grid is a misread number, not a line to throw
            // away: the box slides back inside the grid at the size it was
            // given, so the line keeps its font and is still translated.
            const boxWidth = Math.min(Math.max(1, cells[2]), geometry.columns);
            const boxHeight = Math.min(Math.max(1, cells[3]), geometry.rows);
            const column = Math.min(Math.max(0, cells[0]), geometry.columns - boxWidth);
            const row = Math.min(Math.max(0, cells[1]), geometry.rows - boxHeight);
            const box = cellToPage(crop, geometry.cell, {
                x: column,
                y: row,
                width: boxWidth,
                height: boxHeight,
            });
            x = box.x;
            y = box.y;
            regionWidth = box.width;
            regionHeight = box.height;
            cellBox = { x: column, y: row, width: boxWidth, height: boxHeight };
        } else if (fractions.every((value) => Number.isFinite(value))) {
            const fractionWidth = clamp01(fractions[2]);
            const fractionHeight = clamp01(fractions[3]);
            if (fractionWidth < 0.02 || fractionHeight < 0.02) continue;
            x = crop.x + clamp01(fractions[0]) * crop.width;
            y = crop.y + clamp01(fractions[1]) * crop.height;
            regionWidth = Math.min(crop.x + crop.width - x, fractionWidth * crop.width);
            regionHeight = Math.min(crop.y + crop.height - y, fractionHeight * crop.height);
        } else {
            continue;
        }
        // A box can start outside the crop when a number was read too low.
        const right = Math.min(crop.x + crop.width, x + regionWidth);
        const bottom = Math.min(crop.y + crop.height, y + regionHeight);
        x = Math.max(crop.x, x);
        y = Math.max(crop.y, y);
        regionWidth = right - x;
        regionHeight = bottom - y;
        if (regionWidth < 8 || regionHeight < 8) continue;
        const direction: 'v' | 'h' = item.direction === 'h' || item.direction === 'v'
            ? item.direction
            : Math.abs(degrees) > 45 || (!Number.isFinite(degrees) && regionHeight >= regionWidth)
                ? 'v'
                : 'h';
        const columns = Number.isFinite(Number(item.columns)) ? Math.round(Number(item.columns)) : 1;
        const rows = Number.isFinite(Number(item.rows)) ? Math.round(Number(item.rows)) : 1;
        const region: BlockRegion = {
            x,
            y,
            width: regionWidth,
            height: regionHeight,
            text,
            direction,
            columns: Math.max(1, columns),
            rows: Math.max(1, rows),
            ...(cellBox ? { cells: cellBox } : {}),
            kind: item.type === 'sfx' || item.kind === 'sfx' ? 'sfx' : 'chat',
            ...(typeof item.ruby === 'string' && item.ruby.trim().length > 0
                ? { ruby: item.ruby.trim() }
                : {}),
        };
        // An inclined line is stored as a rotated rectangle: the axis aligned box
        // is what the model saw, and length and thickness come from undoing the
        // rotation of that box.
        if (inclined && Math.abs(axis) >= 0.05) {
            // The model's box is axis aligned, so the length along the text is
            // the projecting side divided by the cosine of the lean. Inverting
            // the whole rectangle instead is fragile, because a loose box makes
            // the thickness larger than the length.
            const along = direction === 'h'
                ? region.width / Math.max(0.35, Math.abs(Math.cos(axis)))
                : region.height / Math.max(0.35, Math.abs(Math.sin(axis)));
            const advance = chars > 0 ? along / chars : 0;
            const em = chars >= 3 && advance >= 6 ? advance : Math.min(region.width, region.height);
            if (!(em >= 4)) continue;
            regions.push({
                ...region,
                angle: foldAngle(axis),
                lineLength: along,
                lineThickness: em,
                glyphSize: em,
            });
            continue;
        }
        for (const piece of splitRegion(region)) {
            // The box is the one the reader read off the grid, so it is already
            // one character across and as long as the line runs.
            piece.glyphSize = piece.direction === 'v' ? piece.width : piece.height;
            regions.push(piece);
        }
    }
    return regions;
}

/**
 * Read every block with the multimodal model. One request per block, so the
 * model sees a whole balloon or caption and can place every line inside it on
 * the grid drawn over the crop.
 */
export async function readBlockRegions(
    bitmap: ImageBitmap,
    blocks: { x: number; y: number; width: number; height: number; score: number }[],
    ocr: OcrRequest,
    /** Line boxes the detector found, drawn on the crop as the text to read. */
    detBoxes: { x: number; y: number; width: number; height: number }[] = [],
): Promise<BlockReading[]> {
    const readings: BlockReading[] = blocks.map((block) => ({ block: { ...block }, regions: [], cell: 0, boxes: [] }));
    if (blocks.length === 0) return readings;

    const queue = blocks.map((_, index) => index);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (true) {
            const cursor = next;
            next += 1;
            if (cursor >= queue.length) return;
            const index = queue[cursor];
            const reading = readings[index];
            // The blk box can be tighter than the text it holds; the margin
            // lets the reader see a line that starts just outside it, and the
            // cells are mapped against this same box so nothing shifts.
            const padded = blockCropBox(bitmap.width, bitmap.height, reading.block);
            const crop = { ...padded, score: reading.block.score };
            // Only the detector's line boxes that reach this block: they are
            // what the prompt calls the text to read, so a stray box from the
            // panel next door must not appear on the crop.
            const inside = detBoxes.filter((box) => (
                box.x < padded.x + padded.width && box.x + box.width > padded.x
                && box.y < padded.y + padded.height && box.y + box.height > padded.y
            )).slice(0, 40).map((box) => ({ x: box.x, y: box.y, width: box.width, height: box.height }));
            reading.boxes = inside;
            let dataUrl: string;
            try {
                dataUrl = blockToDataUrl(bitmap, reading.block, inside);
            } catch (cause) {
                console.warn('Block reading could not cut one block.', cause);
                continue;
            }
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    const content = await deepSeekContentForSync(ocr.key, [dataUrl], BLOCK_PROMPT, READ_EFFORT);
                    reading.raw = content;
                    console.info(`[read] block ${index + 1}: ${content.slice(0, 3000)}`);
                    reading.cropUrl = dataUrl;
                    const parsed = readBlockAnswer(content, crop);
                    const kept = dropReadingsInsideColumns(parsed);
                    if (kept.length !== parsed.length) {
                        console.info(`[read] dropped ${parsed.length - kept.length} reading(s) inside a column`);
                    }
                    reading.regions = separateOverlaps(mergeCompanionRegions(kept));
                    const geometry = gridGeometry(crop);
                    reading.cell = geometry.cell;
                    console.info(`[grid] block ${index + 1}: ${geometry.columns} x ${geometry.rows} cells `
                        + `of ${reading.cell}px, ${reading.regions.length} line(s)`);
                    break;
                } catch (cause) {
                    if (attempt === 0) {
                        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
                        continue;
                    }
                    console.warn('Block reading failed for one block.', cause);
                }
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()));
    return readings;
}
