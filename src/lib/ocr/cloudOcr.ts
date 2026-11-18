import type { BoxData, OcrRequest } from '../../shared/types';
import type { ReasoningEffort } from '../../shared/constants';
import { majorAxis } from '../rect';
import type { OcrResult, TextLine, TextMask } from '../types';
import { cropSize, drawUpright } from '../warp';
import { blockCropBox, blockCropDataUrl, blockCropScale } from './blockCrop';
import { cellToPage, gridGeometry } from './grid';
import { recognizeLine } from './recognize';
import { isLoneGlyph, spokenGlyphs } from '../loneGlyph';
import { MODEL_SIZE } from '../mask';
import { readBlockHint, type BlockHint } from './blockHints';

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
 * Read one line that no block claimed, straight from the cloud model.
 *
 * A line outside every blk box is never inside a block crop, so the block reader
 * cannot report it: the 円 printed in the corner of a speech balloon stayed
 * untranslated because the blk head missed its balloon. The line's own crop is
 * read here, and the device recogniser stands in when the request fails.
 */
export async function readUnclaimedLine(
    bitmap: ImageBitmap,
    line: TextLine,
    key: string,
): Promise<BoxData> {
    // The device recogniser is trained on printed manga and wins on a tight
    // crop of one glyph: it reads 円 at 0.99 where the cloud read 門, and a name
    // read as 門 is translated as 門. This is the same rule the line path uses,
    // a confident device reading is never replaced by a general vision model.
    const local = await recognizeLine(bitmap, line, line.direction === 'vertical')
        .catch(() => ({ text: '', confidence: 0 }));
    const localText = local.text.trim();
    if (localText.length > 0 && local.confidence >= ASSIST_BELOW) {
        return { ...line, text: localText, confidence: local.confidence };
    }
    try {
        const dataUrl = cropToDataUrl(bitmap, line);
        const found = await readOneCrop(requestDeepSeek, key, dataUrl, READ_EFFORT);
        const text = found?.[0]?.text.trim() ?? '';
        if (text.length > 0) return { ...line, text, confidence: 1 };
    } catch (cause) {
        console.warn('Reading an unclaimed line in the cloud failed.', cause);
    }
    return { ...line, text: localText, confidence: local.confidence };
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
    /** The frame the label is drawn on: the ink of the column this line names. */
    frame?: { x: number; y: number; width: number; height: number };
    /** The blue boxes the reader named, 1-based, in the order it gave them. */
    boxIds?: number[];
    /** Size of one glyph of this line, in page pixels. Undefined when unknown. */
    glyphSize?: number;
    /** The same line in Traditional Chinese, written in the reading call. */
    translation?: string;
    /** Dialogue, a name or a sound effect. */
    kind: 'chat' | 'sfx' | 'name';
    /** Furigana the model saw on this line. Kept for inspection, never merged. */
    ruby?: string;
    /** Lean of the text axis in radians, as the rest of the pipeline stores it. */
    angle?: number;
    /** Length of the line along that axis, for an inclined line. */
    lineLength?: number;
    /** Thickness across that axis, for an inclined line. */
    lineThickness?: number;
    /** The model's own box before a named detector box replaced it. */
    own?: { x: number; y: number; width: number; height: number };
};

export type BlockReading = {
    block: { x: number; y: number; width: number; height: number; score: number };
    regions: BlockRegion[];
    /** The on-device reading the reader was given as a reference, if any. */
    hint?: BlockHint;
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
 * The box is in page pixels, read off the numbers printed on the grid: a cell
 * count is what drifted, because a cell of a coarse grid is wider than a
 * character and a glyph that touched two cells came back two cells wide.
 */
const REGION_EXAMPLE = {
    text: '…',
    type: 'chat',
    direction: 'v',
    // How far the line leans, clockwise from upright, and the size of one
    // character in page pixels. Both are required: a leaned line drawn upright
    // is the one thing the reader cannot leave to a box edge.
    lean: 0,
    em: 24,
    // The number printed on the blue rectangle that holds the line. The page
    // box follows, for a crop whose numbers cannot be read.
    box: 2,
    x: 268,
    y: 412,
    width: 27,
    height: 162,
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
    'A grid is drawn over the image and every line of it carries its page coordinate: thin lines mark single cells, a thicker line marks every fifth. The numbers along the top edge are blue and are the x of that line in page pixels; the numbers along the left edge are red and are its y. They are absolute page pixels, not a count: a line printed 1035 is x 1035 on the page, wherever the crop starts. A small grey number beside every fifth coordinate is the cell index, which you do not need.',
    'A reading can sit inside a blue rectangle, in the gap between the large characters and the box edge. It is still not a line: the entry covers the large characters, its box stays on the large characters, and the reading is left out of text. Never report it in any field. Small kana that belong to the word itself, such as the っ in いって, are part of the word and stay.',
    'type: "chat" for dialogue, including a short はい, うん, ええ, そう, ああ, いえ, いや and a line that starts with an ellipsis. "name" for a box that holds a name, a title, a place name or a label and no sentence: 有留木 環 is a name, and so is a lone 円 printed with its reading つぶら beside it. "sfx" for onomatopoeia and sound effects such as ドドド, ゴゴゴ, ザワザワ, ドン, バン, ガシャ.',
    'direction: "v" when the line reads top to bottom, "h" when it reads left to right. A leaned line is still "v" or "h": do not use another letter for it.',
    'lean: for a leaned line, how far it is rotated clockwise from upright, in degrees between -45 and 45. A vertical line is upright when it runs straight down; if the bottom of the column leans left, lean is positive (for example 12). A horizontal line is upright when it runs left to right; if its right end rises, lean is negative. Every entry must carry lean; give 0 when the line is upright.',
    'em: the size of one character in page pixels, measured across the glyph itself (its width and height are about equal), not the gap between columns and not the whole box. Read it from the grid lines. Every entry must carry em, even when the line is upright.',
    'angle: the old name for lean, kept only for a horizontal line measured from the horizontal axis. Prefer lean; do not send both.',
    'box: the number printed in green at the top left corner of the blue rectangle that holds this line. This is the position that matters: the rectangle is where the ink is, so naming it is exact. If one entry covers more than one rectangle, give their numbers in reading order, as an array, e.g. [3,2].',
    'x and y: only when no number is visible. The page pixel of the top left corner of the line, read from the numbers on the grid: an edge a few pixels past the line printed 1035 is 1037, and one a few pixels above the line printed 140 is 137. width and height: the size of the box in page pixels, from the same numbers.',
    'The box is tight around that line. For a vertical line width is the width of one character and height runs from the top of the first character to the bottom of the last; for a horizontal line height is one character and width is the length of the run. A character is about as many pixels across as it is down, so six characters of a 27 pixel character are about 162 pixels tall. Measure the character you see, not the gap between two grid lines.',
    'Do not round a corner to a grid line and do not count cells: answer with the pixels the number reads, so a character whose left edge is a few pixels past the line printed 1034 has x 1037. x, y, width and height are whole pixels. When an edge is cut off by the crop, still give the page pixel of the visible ink.',
    `The numbers in the example show the shape of the answer, not this crop. Skip artwork with no text. Return JSON only: ${JSON.stringify(BLOCK_EXAMPLE)}`,
].join(' ');

/**
 * The block prompt, with the on-device reading spliced in when there is one.
 *
 * The reference is written as evidence about characters, not as an answer: the
 * recogniser is decisive on a column it can see and blind to the structure
 * around it, so it is quoted column by column and the reader is told what it
 * does wrong. Quoted as a bare string it would read like a transcription to
 * copy, and on this page that is `モノ` for `もの`.
 */
function blockPrompt(hint: BlockHint | null): string {
    if (!hint || hint.lines.length === 0) return BLOCK_PROMPT;
    const read = hint.lines.filter((line) => line.text.trim().length > 0);
    if (read.length === 0) return BLOCK_PROMPT;
    const quoted = hint.lines
        .map((line) => (line.text.trim().length > 0 ? `"${line.text}"` : '(nothing)'))
        .join(', ');
    const complete = read.length === hint.lines.length;
    const reference = [
        `A Japanese recogniser also read this crop on the device, uprighted by about ${Math.round(hint.lean * 180 / Math.PI)} degrees and cut into ${hint.lines.length} column(s). It read ${quoted}, in reading order (right to left).`,
        complete ? `It found text in every one of those columns, so this crop holds at least ${read.length} text line(s).`
            : 'It left at least one column blank, so treat its cut as a guess about where the columns are.',
        'Its characters are often right where its words are wrong: it confuses ヒ and ビ, っ and つ, prints a run of hiragana as katakana, and cuts a column short. Where the quote prints a word in katakana that the image prints in hiragana, write it in hiragana: モノ in the quote is もの when the page prints もの. Read the kana from the image, and use the reference only to confirm a glyph the image leaves ambiguous: never let it replace what the image shows, and never add a line the image does not have.',
    ].join(' ');
    return `${BLOCK_PROMPT} ${reference}`;
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
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
/** The fields the reading tests need: a box, its direction and its text. */
export type Inked = {
    direction: 'v' | 'h';
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
};

/** The side across the line: a vertical column's width, a row's height. */
function acrossSize(item: Inked): number {
    return item.direction === 'v' ? item.width : item.height;
}

/**
 * The line this short kana region reads for, when it is a reading and not a
 * line of its own.
 *
 * A reading printed beside a kanji column sits along the host, is kana only, is
 * narrower than the host, and packs several kana into the advance of one
 * character. A same-size kana column there is dialogue, which
 * `mergeCompanionRegions` folds in instead.
 */
export function readingHostOf<T extends Inked>(region: T, others: T[], widest: number): T | undefined {
    const text = region.text.replace(/[\s、。！？…「」『』]/gu, '');
    if (!(text.length > 0 && text.length <= 8 && KANA_ONLY.test(text))) return undefined;
    const glyphs = (item: Inked): number => [...item.text.replace(/\s/gu, '')].length;
    const spanAcross = (item: Inked): [number, number] => (
        item.direction === 'v' ? [item.x, item.x + item.width] : [item.y, item.y + item.height]
    );
    const spanAlong = (item: Inked): [number, number] => (
        item.direction === 'v' ? [item.y, item.y + item.height] : [item.x, item.x + item.width]
    );
    // Length along the line per character. Furigana packs several kana beside
    // one or two kanji, so its advance is a fraction of the host's even when
    // the reader gives both boxes the same width in whole cells.
    const advance = (item: Inked): number => {
        const [from, to] = spanAlong(item);
        return (to - from) / Math.max(1, glyphs(item));
    };
    return others.find((host) => {
        if (host === region) return false;
        if (host.direction !== region.direction) return false;
        if (acrossSize(region) > acrossSize(host)) return false;
        // A reading is printed beside its column, so its box is narrower than
        // the column's. Equal widths mean the reader named one rectangle for
        // both entries — every entry of a block the detector boxed as one — and
        // then the only thing that differs is the length of the text. The
        // advance test below would read a six glyph column as a reading of a
        // four glyph one and drop it, which is how a three column speech lost
        // its ヒーローものは.
        if (acrossSize(region) > acrossSize(host) - 2) return false;
        const [hostFrom, hostTo] = spanAlong(host);
        const [from, to] = spanAlong(region);
        const overlap = Math.min(hostTo, to) - Math.max(hostFrom, from);
        if (overlap < (to - from) * 0.5) return false;
        const [hostStart, hostEnd] = spanAcross(host);
        const [ownStart, ownEnd] = spanAcross(region);
        // A reading inside the column's own band, clearly thinner than it.
        if (ownStart >= hostStart - 1 && ownEnd <= hostEnd + 1
            && acrossSize(region) <= widest * 0.7
            && acrossSize(host) >= acrossSize(region) * 1.5) {
            return true;
        }
        const gap = Math.max(hostStart - ownEnd, ownStart - hostEnd, 0);
        if (gap > acrossSize(host)) return false;
        // A one glyph host is a name, not a word the reader can compare by
        // advance; its reading is still a reading.
        if (glyphs(host) < 1 || glyphs(region) < 2) return false;
        return advance(region) <= advance(host) * 0.75;
    });
}

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
    const widest = Math.max(...regions.map(acrossSize));
    if (!(widest > 0)) return regions;
    return regions.filter((region) => !readingHostOf(region, regions, widest));
}

/** True when this region is the reading of a line that is already a line. */
export function isReadingOfAny(region: Inked, hosts: Inked[]): boolean {
    if (hosts.length === 0) return false;
    const widest = Math.max(...hosts.map(acrossSize), acrossSize(region));
    return readingHostOf(region, hosts, widest) !== undefined;
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
        // A lone kanji is a name. Kana printed beside a name is its reading,
        // not a second word: 円 with つぶら beside it is 円, never つぶら円.
        if (isLoneGlyph(host.text)) continue;
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

/** The word a region holds: its glyphs, without the marks that carry no sound. */
function inkOf(text: string): string {
    return spokenGlyphs(text.normalize('NFKC')).join('');
}

/** How much of the smaller of two boxes the two boxes share, 0 to 1. */
function sharedShare(
    left: { x: number; y: number; width: number; height: number },
    right: { x: number; y: number; width: number; height: number },
): number {
    const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
    const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
    if (width <= 0 || height <= 0) return 0;
    return (width * height) / Math.min(left.width * left.height, right.width * right.height);
}

/**
 * Drop a region that is a second reading of the same ink.
 *
 * The blk head can hand back a block nested inside another block's box: one
 * page came back with the tight name plate (212,958 79x339), the tight caption
 * beside it, and a loose block (94,962 193x525) that covered both. Every block
 * is cropped and read on its own, so the plate's columns were read twice, and
 * the loose block's grid was coarse enough to report 花岡修太郎 and 三十九歳 as
 * one line 花岡修太郎 三十九歳. Every reading was true and the page got both:
 * two groups over one plate, one group's source holding 未婚独身彼女ナシ平社員
 * twice, and a translation that repeated itself (未婚 / 沒女友, 普通職員 /
 * 基層職員, 人生失敗組 in two columns).
 *
 * One piece of ink is one line. Inside a nested pair the contained block is the
 * tighter reading, so a container's region is a repeat when its word is the
 * word of a contained region, or the join of the run of them: the two grids
 * describe the same glyphs and do not have to agree on the cell box. Two blocks
 * that are not nested repeat each other only when their boxes overlap, so an
 * identical line in the next balloon is left alone.
 *
 * A block whose regions are all repeats is left with none, and the caller drops
 * it, so it neither translates nor gates the erase.
 */
export function dropRepeatedReadings<T extends { block: { x: number; y: number; width: number; height: number }; regions: BlockRegion[] }>(
    readings: T[],
): T[] {
    const dropped = new Set<string>();
    const mark = (index: number, at: number, why: string): void => {
        dropped.add(`${index}:${at}`);
        console.info(`[read] block ${index + 1}: ${JSON.stringify(readings[index].regions[at].text)} ${why}`);
    };

    // A block nested in another block's box is the tighter reading of that ink.
    readings.forEach((reading, index) => {
        const children = readings.filter((other) => other !== reading && containsBlock(reading.block, other.block));
        if (children.length === 0) return;
        const inside = children.flatMap((child) => child.regions);
        const words = new Set(inside.map((region) => inkOf(region.text)));
        reading.regions.forEach((region, at) => {
            const word = inkOf(region.text);
            if (word.length === 0) return;
            if (words.has(word)) {
                mark(index, at, 'is already read by the block inside it');
                return;
            }
            if (joinedRuns(region, inside).has(word)) {
                mark(index, at, 'is the join of the columns already read inside it');
                return;
            }
            // The two grids do not have to agree on the cell box, and they do
            // not have to agree on the glyph either: this page was read as
            // 三十九歳 by the loose block and 二十九歳 by the tight one. A line
            // that lies on ink the nested block already read is that ink.
            if (inside.some((child) => sharedShare(region, child) >= 0.3)) {
                mark(index, at, 'lies on ink the block inside it already read');
            }
        });
    });

    // Two blocks that overlap without nesting, or the same block read twice.
    const entries = readings.flatMap((reading, index) => reading.regions.map((region, at) => ({ index, at, region })));
    const order = [...entries].sort((left, right) => (
        left.region.width * left.region.height - right.region.width * right.region.height
    ));
    const kept = new Map<string, BlockRegion>();
    for (const entry of order) {
        const key = `${entry.index}:${entry.at}`;
        if (dropped.has(key)) continue;
        const same = [...kept.values()].find((other) => (
            sharedShare(entry.region, other) >= 0.3 && inkOf(entry.region.text) === inkOf(other.text)
        ));
        if (same) {
            mark(entry.index, entry.at, `is the ink of ${JSON.stringify(same.text)}, already read`);
            continue;
        }
        kept.set(key, entry.region);
    }

    return readings.map((reading, index) => ({
        ...reading,
        regions: reading.regions.filter((_, at) => !dropped.has(`${index}:${at}`)),
    }));
}

/** True when `inner` sits inside `outer`: the same ink, read twice. */
function containsBlock(
    outer: { x: number; y: number; width: number; height: number },
    inner: { x: number; y: number; width: number; height: number },
): boolean {
    if (outer.width * outer.height <= inner.width * inner.height * 1.1) return false;
    return sharedShare(outer, inner) >= 0.9;
}

/** Every join of two or more neighbouring regions, in the order they are read. */
function joinedRuns(anchor: BlockRegion, regions: BlockRegion[]): Set<string> {
    const ordered = readersOrdered(anchor, regions);
    const runs = new Set<string>();
    for (let from = 0; from < ordered.length; from += 1) {
        let joined = '';
        for (let to = from; to < ordered.length; to += 1) {
            joined += inkOf(ordered[to].text);
            if (to > from) runs.add(joined);
        }
    }
    return runs;
}

/** The regions in the order they are read: down the column, right to left. */
function readersOrdered<T extends Inked>(anchor: T, regions: T[]): T[] {
    const vertical = anchor.direction === 'v';
    return [...regions].sort((left, right) => (
        vertical
            ? (right.x - left.x) || (left.y - right.y)
            : (left.y - right.y) || (left.x - right.x)
    ));
}

/**
 * The frame of the column the reader named, from the boxes drawn on its crop.
 *
 * The reader is asked where a line sits, and it answers; the answer is an
 * estimate, and the estimates were 20 page pixels out at best, 100 at worst —
 * enough to put a label beside its column, which is the drift this function
 * removes. The detector's boxes were drawn on the same crop in blue, and they
 * are the ink itself. So the reader keeps the part it is good at — which column
 * of the block, in which order — and the frame takes its edges from the ink:
 *
 * - the candidates are the boxes that share the reader's band across the line,
 *   with at least half of its width, which is how one column is told from the
 *   one beside it;
 * - they are unioned along the line, so a column the reader reported short is
 *   still framed from its first character to its last;
 * - a box much wider than the reader's band covers several columns and the
 *   reader is splitting it, so the band stays the reader's and only the length
 *   is taken from the ink.
 *
 * A line whose band holds no box keeps the reader's own box: a detector that
 * missed the line is the one case where its estimate is all there is.
 */
function inkFrameOf(
    region: { x: number; y: number; width: number; height: number; direction: 'v' | 'h' },
    boxes: { x: number; y: number; width: number; height: number }[],
    siblings: { x: number; y: number; width: number; height: number }[] = [],
): { x: number; y: number; width: number; height: number } | null {
    if (boxes.length === 0) return null;
    const vertical = region.direction === 'v';
    const across = (box: { x: number; y: number; width: number; height: number }): [number, number] => (
        vertical ? [box.x, box.x + box.width] : [box.y, box.y + box.height]
    );
    const along = (box: { x: number; y: number; width: number; height: number }): [number, number] => (
        vertical ? [box.y, box.y + box.height] : [box.x, box.x + box.width]
    );
    const [ownFrom, ownTo] = across(region);
    // Which boxes the reader's band names: those whose overlap with it is
    // within a tenth of the best overlap. A fixed share of the band was too
    // strict — a box 14 pixels off a 27 pixel band shares 48% of it and was
    // dropped — and too loose at the same time, because a band in the gap
    // between two columns shares 40% with both. Relative to the best overlap,
    // one clear winner is the column and a tie is a box over two columns.
    const overlaps = boxes.map((box) => {
        const [from, to] = across(box);
        return { box, shared: Math.min(ownTo, to) - Math.max(ownFrom, from) };
    });
    const best = Math.max(...overlaps.map((one) => one.shared));
    if (!(best > 0)) return null;
    const candidates = overlaps
        .filter((one) => one.shared >= best * 0.9)
        .map((one) => one.box);
    if (candidates.length === 0) return null;
    // A box that does not touch the reader's run is the line above or below,
    // not this one: only boxes on the same run are unioned.
    const [runFrom, runTo] = along(region);
    const near = candidates.filter((box) => {
        const [from, to] = along(box);
        return Math.min(runTo, to) - Math.max(runFrom, from) >= 0;
    });
    const run = near.length > 0 ? near : candidates;
    const ink = {
        x: Math.min(...run.map((box) => box.x)),
        y: Math.min(...run.map((box) => box.y)),
        width: Math.max(...run.map((box) => box.x + box.width)) - Math.min(...run.map((box) => box.x)),
        height: Math.max(...run.map((box) => box.y + box.height)) - Math.min(...run.map((box) => box.y)),
    };
    const [inkFrom, inkTo] = across(ink);
    // One box can hold two columns when the detector could not separate them,
    // and the reader splits it into two entries. The sign of that is a second
    // entry inside the same band; only then is the reader's own band the better
    // half. A single entry in a box that is merely wider than its estimate is
    // not a split, and the ink is the better width.
    const shared = siblings.some((other) => other !== region
        && Math.abs((across(other)[0] + across(other)[1]) / 2 - (inkFrom + inkTo) / 2) < (inkTo - inkFrom) / 2);
    if (shared) {
        return vertical
            ? { x: region.x, y: ink.y, width: region.width, height: ink.height }
            : { x: ink.x, y: region.y, width: ink.width, height: region.height };
    }
    return ink;
}

/**
 * The boxes that are a column of this block, not a reading printed beside one.
 *
 * The det head draws a box around furigana as readily as around the column it
 * belongs to: the つぶら beside 円 came back as a 21 pixel box on a page whose
 * columns are 44. Drawn in blue, that box says "this is text to read", and a
 * reader counting four boxes for three columns hands one line the reading's
 * box. A reading is thin and runs beside a column it shares its length with, so
 * it is dropped from the crop, and the prompt's rule that furigana is not text
 * is then true of the picture as well as of the words.
 */
function columnBoxes<T extends { x: number; y: number; width: number; height: number }>(boxes: T[]): T[] {
    if (boxes.length < 2) return boxes;
    const vertical = boxes.filter((box) => box.height >= box.width).length >= boxes.length / 2;
    const thicknessOf = (box: T): number => (vertical ? box.width : box.height);
    const thicknesses = boxes.map(thicknessOf).sort((left, right) => left - right);
    const median = thicknesses[thicknesses.length >> 1];
    if (!(median > 0)) return boxes;
    const spanOf = (box: T): [number, number] => (
        vertical ? [box.y, box.y + box.height] : [box.x, box.x + box.width]
    );
    return boxes.filter((box) => {
        if (thicknessOf(box) >= median * 0.6) return true;
        const [from, to] = spanOf(box);
        const beside = boxes.some((other) => {
            if (other === box || thicknessOf(other) < thicknessOf(box) * 1.4) return false;
            const [otherFrom, otherTo] = spanOf(other);
            return Math.min(to, otherTo) - Math.max(from, otherFrom) >= (to - from) * 0.5;
        });
        return !beside;
    });
}

/**
 * The frame of every region of one block.
 *
 * The reader is good at naming a line and bad at measuring one: asked where a
 * line sits it answered 20 page pixels out at best and a whole column out at
 * worst. The detector's boxes are the ink, so the frame is built from them and
 * the reader's own box is only a hint:
 *
 * - when a block has exactly as many boxes as entries, the entries are in
 *   reading order and so are the boxes, so the i-th entry takes the i-th box.
 *   This is the common case and the one that cannot drift at all.
 * - otherwise each entry takes the boxes that share its band, which is what
 *   lets one entry split a box the detector merged, and what keeps a two entry
 *   box from becoming one label over two columns.
 *
 * A line whose band holds no box keeps the reader's own box: a detector that
 * missed the line is the one case where its estimate is all there is.
 */
function blockFrames(
    regions: { x: number; y: number; width: number; height: number; direction: 'v' | 'h'; boxIds?: number[] }[],
    boxes: { x: number; y: number; width: number; height: number }[],
): ({ x: number; y: number; width: number; height: number } | undefined)[] {
    if (boxes.length === 0) return regions.map(() => undefined);
    const unionOf = (list: { x: number; y: number; width: number; height: number }[]) => {
        const x = Math.min(...list.map((box) => box.x));
        const y = Math.min(...list.map((box) => box.y));
        const right = Math.max(...list.map((box) => box.x + box.width));
        const bottom = Math.max(...list.map((box) => box.y + box.height));
        return { x, y, width: right - x, height: bottom - y };
    };

    // The rectangle each entry named. A number two entries share is not a name
    // but a box the detector merged and the reader split, so it is dropped here
    // and the band split below decides.
    const claims = new Map<number, number>();
    for (const region of regions) {
        for (const id of region.boxIds ?? []) claims.set(id, (claims.get(id) ?? 0) + 1);
    }
    const claimed = new Set<number>();
    const frames = regions.map((region) => {
        const ids = (region.boxIds ?? []).filter((id) => id <= boxes.length && claims.get(id) === 1);
        if (ids.length === 0) return undefined;
        ids.forEach((id) => claimed.add(id));
        return unionOf(ids.map((id) => boxes[id - 1]));
    });
    const missing = frames.map((frame, at) => (frame ? -1 : at)).filter((at) => at >= 0);
    if (missing.length === 0) return frames;
    const free = boxes.filter((_, index) => !claimed.has(index + 1));

    if (free.length === missing.length) {
        // Nothing named and nothing left over: the entries are in reading order
        // and so are the boxes, so the i-th entry takes the i-th box.
        const ordered = [...free].sort((left, right) => {
            const band = Math.max(left.height, right.height) * 0.35;
            if (Math.abs(left.y - right.y) > band) return left.y - right.y;
            return right.x - left.x;
        });
        missing.forEach((at, index) => {
            frames[at] = { ...ordered[index] };
        });
        return frames;
    }
    for (const at of missing) {
        frames[at] = inkFrameOf(regions[at], free.length > 0 ? free : boxes, regions) ?? undefined;
    }
    return frames;
}

/** Read the regions of one block and map their boxes to page pixels. */
function readBlockAnswer(
    content: string,
    crop: BlockReading['block'],
    cell: number,
    boxes: { x: number; y: number; width: number; height: number }[] = [],
): BlockRegion[] {
    const parsed = JSON.parse(extractJson(content)) as {
        regions?: { text?: unknown; type?: unknown; kind?: unknown; ruby?: unknown; direction?: unknown; columns?: unknown; rows?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown; left?: unknown; top?: unknown; angle?: unknown; lean?: unknown; em?: unknown; box?: unknown; boxes?: unknown }[];
        lines?: unknown;
    };
    const items = Array.isArray(parsed.regions) ? parsed.regions : [];
    if (items.length === 0) return [];
    const geometry = gridGeometry(crop, cell);
    const scale = blockCropScale(crop);
    const regions: BlockRegion[] = [];
    for (const item of items) {
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        if (text.length === 0) continue;
        const degrees = Number(item.angle);
        // The answer is in page pixels, read off the numbers printed on the
        // grid. A cell box and a fraction are still accepted, so a reader that
        // ignores the numbers does not lose the line, but they are fallbacks:
        // the cell box is what drifted, so it is the last thing asked for.
        const numbers = [item.x, item.y, item.width, item.height].map(Number);
        const fractions = [item.left, item.top, item.width, item.height].map(Number);
        const whole = numbers.every((value) => Number.isFinite(value));
        const box = { x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] };
        /** A box that starts inside `from` and can be trimmed to it. */
        const startsIn = (
            candidate: { x: number; y: number; width: number; height: number },
            fromX: number,
            fromY: number,
            toX: number,
            toY: number,
        ): boolean => candidate.width >= 6 && candidate.height >= 6
            && candidate.x >= fromX - 8 && candidate.y >= fromY - 8
            && candidate.x < toX && candidate.y < toY;
        const asCells = whole && numbers.every((value) => Number.isInteger(value))
            && numbers[0] >= 0 && numbers[1] >= 0 && numbers[2] >= 1 && numbers[3] >= 1
            && numbers[0] <= geometry.columns + 1 && numbers[1] <= geometry.rows + 1
            && numbers[2] <= geometry.columns + 1 && numbers[3] <= geometry.rows + 1;
        // The rectangle the reader named, when it named one. An index off the
        // end is a misread number, not a line.
        const named = (Array.isArray(item.box) ? item.box : [item.box ?? item.boxes])
            .flat()
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value >= 1 && value <= boxes.length)
            .slice(0, 4);
        // The reader sometimes writes box 0, or leaves the field out, on a
        // crop that has exactly one rectangle. There is no choice to make:
        // the entry is that rectangle. Without this the region has no box, the
        // lean is never measured, and the label is drawn upright.
        if (named.length === 0 && boxes.length === 1) named.push(1);
        let x: number;
        let y: number;
        let regionWidth: number;
        let regionHeight: number;
        let cellBox: { x: number; y: number; width: number; height: number } | undefined;
        if (named.length > 0) {
            // The named box is the position: the reader chose a rectangle the
            // detector drew around the ink, which is exact, where a coordinate
            // it reads is an estimate. The numbers are only a fallback now.
            const picked = named.map((id) => boxes[id - 1]);
            x = Math.min(...picked.map((one) => one.x));
            y = Math.min(...picked.map((one) => one.y));
            regionWidth = Math.max(...picked.map((one) => one.x + one.width)) - x;
            regionHeight = Math.max(...picked.map((one) => one.y + one.height)) - y;
        } else if (whole && startsIn(box, crop.x, crop.y, crop.x + crop.width, crop.y + crop.height)
            && box.width <= crop.width * 1.2 && box.height <= crop.height * 1.2) {
            // Page pixels, exactly as the numbers on the grid read.
            x = box.x;
            y = box.y;
            regionWidth = box.width;
            regionHeight = box.height;
        } else if (asCells) {
            // Whole cells only: a half the model sends anyway is rounded to the
            // nearer line, so a box always starts on a grid line.
            const cells = numbers.map((value) => Math.round(value));
            // A cell outside the grid is a misread number, not a line to throw
            // away: the box slides back inside the grid at the size it was
            // given, so the line keeps its font and is still translated.
            const boxWidth = Math.min(Math.max(1, cells[2]), geometry.columns);
            const boxHeight = Math.min(Math.max(1, cells[3]), geometry.rows);
            const column = Math.min(Math.max(0, cells[0]), geometry.columns - boxWidth);
            const row = Math.min(Math.max(0, cells[1]), geometry.rows - boxHeight);
            const mapped = cellToPage(crop, geometry.cell, {
                x: column,
                y: row,
                width: boxWidth,
                height: boxHeight,
            });
            x = mapped.x;
            y = mapped.y;
            regionWidth = mapped.width;
            regionHeight = mapped.height;
            cellBox = { x: column, y: row, width: boxWidth, height: boxHeight };
        } else if (whole && startsIn(
            box,
            0,
            0,
            crop.width * scale,
            crop.height * scale,
        ) && box.width <= crop.width * scale * 1.2 && box.height <= crop.height * scale * 1.2) {
            // Pixels of the crop image itself, which is the page upscaled: a
            // reader that ignored the numbers still measured the right place,
            // it just measures it on the image it was sent.
            x = crop.x + box.x / scale;
            y = crop.y + box.y / scale;
            regionWidth = box.width / scale;
            regionHeight = box.height / scale;
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
        const direction: 'v' | 'h' = item.direction === 'h'
            ? 'h'
            : item.direction === 'v' || item.direction === 'i'
                ? 'v'
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
            ...(named.length > 0 ? { boxIds: named.slice(0, 4) } : {}),
            kind: item.type === 'sfx' || item.kind === 'sfx'
                ? 'sfx'
                : item.type === 'name' || item.kind === 'name' ? 'name' : 'chat',
            ...(typeof item.ruby === 'string' && item.ruby.trim().length > 0
                ? { ruby: item.ruby.trim() }
                : {}),
        };
        // The reader's own page box, kept beside the named detector box: when
        // two columns share one blue rectangle, the named box is the same for
        // both and using it for both put two labels on top of each other. The
        // own box still says which column is which.
        if (whole && box.width >= 4 && box.height >= 4) {
            region.own = {
                x: Math.max(crop.x, Math.min(crop.x + crop.width - 1, box.x)),
                y: Math.max(crop.y, Math.min(crop.y + crop.height - 1, box.y)),
                width: box.width,
                height: box.height,
            };
        }
        // The reader still says "v" and often a lean for a column. Its lean is
        // not used for geometry: it came back 0 for a 5 degree column and -7
        // for a 15.5 degree one, with the sign reversed. The ink's own angle is
        // measured later, where the mask is in hand. Only its em is kept as a
        // second opinion on the glyph size.
        const em = Number(item.em);
        if (Number.isFinite(em) && em >= 4 && em <= 300) region.glyphSize = em;
        for (const piece of splitRegion(region)) {
            // The box is the one the reader read off the grid, so it is already
            // one character across and as long as the line runs.
            if (piece.glyphSize === undefined) {
                piece.glyphSize = piece.direction === 'v' ? piece.width : piece.height;
            }
            regions.push(piece);
        }
    }
    return mergeCharacterRegions(regions);
}

/**
 * Fold one-character entries back into the column they are characters of.
 *
 * The reader sometimes answers one entry per character: the 回卒業証書授 banner
 * came back as six entries, all naming the same blue rectangle. Six labels on
 * one column is not a reading, and each character would be translated on its
 * own. Entries that share a column, carry at most two glyphs each and run down
 * the same band are one line; their text joins in reading order.
 */
function mergeCharacterRegions(regions: BlockRegion[]): BlockRegion[] {
    if (regions.length < 2) return regions;
    const groups = new Map<string, BlockRegion[]>();
    for (const region of regions) {
        const id = region.boxIds?.[0];
        const own = region.own ?? region;
        const key = id !== undefined
            ? `box:${id}`
            : `own:${region.direction}:${Math.round(own.x / 8)}:${Math.round(own.y / 8)}`;
        const list = groups.get(key);
        if (list) list.push(region);
        else groups.set(key, [region]);
    }
    const out: BlockRegion[] = [];
    for (const group of groups.values()) {
        // One entry per character is the usual shape, but the reader also
        // splits the 31 off the banner and leaves 回卒業証書授 as one entry.
        // Two or more entries in one band are pieces of one column when at
        // least one of them is that short; two full columns stay apart.
        const oneGlyph = group.some((region) => [...region.text].length <= 2);
        if (group.length < 2 || !oneGlyph) {
            out.push(...group);
            continue;
        }
        const direction = group[0].direction;
        const boxes = group.map((region) => region.own ?? region);
        const across = (box: { x: number; y: number; width: number; height: number }): [number, number] => (
            direction === 'v' ? [box.x, box.x + box.width] : [box.y, box.y + box.height]
        );
        const [groupFrom, groupTo] = across({
            x: Math.min(...boxes.map((box) => box.x)),
            y: Math.min(...boxes.map((box) => box.y)),
            width: Math.max(...boxes.map((box) => box.x + box.width)) - Math.min(...boxes.map((box) => box.x)),
            height: Math.max(...boxes.map((box) => box.y + box.height)) - Math.min(...boxes.map((box) => box.y)),
        });
        const sameBand = boxes.every((box) => {
            const [from, to] = across(box);
            return Math.min(groupTo, to) - Math.max(groupFrom, from) >= Math.min(to - from, groupTo - groupFrom) * 0.4;
        });
        if (!sameBand) {
            out.push(...group);
            continue;
        }
        const along = (box: { x: number; y: number; width: number; height: number }): number => (
            direction === 'v' ? box.y : box.x
        );
        const ordered = [...group].sort((left, right) => along(left.own ?? left) - along(right.own ?? right));
        const left = Math.min(...ordered.map((region) => (region.own ?? region).x));
        const top = Math.min(...ordered.map((region) => (region.own ?? region).y));
        const right = Math.max(...ordered.map((region) => (region.own ?? region).x + (region.own ?? region).width));
        const bottom = Math.max(...ordered.map((region) => (region.own ?? region).y + (region.own ?? region).height));
        const sizes = ordered
            .map((region) => region.glyphSize)
            .filter((size): size is number => typeof size === 'number' && size >= 4)
            .sort((a, b) => a - b);
        const first = ordered[0];
        out.push({
            ...first,
            text: ordered.map((region) => region.text).join(''),
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
            glyphSize: sizes.length > 0 ? sizes[sizes.length >> 1] : first.glyphSize,
            boxIds: [...new Set(ordered.flatMap((region) => region.boxIds ?? []))],
            own: { x: left, y: top, width: right - left, height: bottom - top },
        });
    }
    return out;
}

/**
 * The lean of the ink inside one box, in radians, clockwise from upright.
 *
 * The reader is asked for the lean and still answers 0 for a column that
 * visibly tilts: it reads the characters as a vertical line and the lean is
 * not something it reports. The segmentation plane does not have that
 * ambiguity. Its glyph pixels in a column form an elongated cloud, and the
 * major axis of that cloud is the direction the column runs. A vertical
 * column's major axis is near +-90 degrees; the few degrees it is off are the
 * lean this returns.
 */
function leanOfBox(
    mask: TextMask | null,
    box: { x: number; y: number; width: number; height: number },
    direction: 'v' | 'h',
): { lean: number; thickness: number } | undefined {
    if (!mask) return undefined;
    const x0 = Math.max(0, Math.floor(box.x * mask.scale + mask.padX));
    const y0 = Math.max(0, Math.floor(box.y * mask.scale + mask.padY));
    const x1 = Math.min(MODEL_SIZE - 1, Math.ceil((box.x + box.width) * mask.scale + mask.padX));
    const y1 = Math.min(MODEL_SIZE - 1, Math.ceil((box.y + box.height) * mask.scale + mask.padY));
    if (x1 <= x0 || y1 <= y0) return undefined;
    const points: { x: number; y: number }[] = [];
    for (let my = y0; my <= y1; my += 1) {
        for (let mx = x0; mx <= x1; mx += 1) {
            if (mask.data[my * MODEL_SIZE + mx] < 0.3) continue;
            points.push({ x: (mx - mask.padX) / mask.scale, y: (my - mask.padY) / mask.scale });
            if (points.length >= 40000) break;
        }
        if (points.length >= 40000) break;
    }
    // A handful of pixels is not a direction; a small glyph still has dozens.
    if (points.length < 24) return undefined;
    const axis = majorAxis(points);
    if (axis === null) return undefined;
    const lean = direction === 'v'
        ? (axis < 0 ? axis + Math.PI / 2 : axis - Math.PI / 2)
        : axis;
    if (!Number.isFinite(lean) || Math.abs(lean) > Math.PI / 4) return undefined;
    // How wide the ink is across the lean. The interquartile range drops a
    // stray stroke and the far column of a merged box, so this is the glyph
    // column, not the box. The reader's em and this are two measurements of
    // one glyph; the narrower one is used, because the box edge never
    // under-states a glyph the way the axis aligned box over-states it.
    const cos = Math.cos(lean);
    const sin = Math.sin(lean);
    const across = points
        .map((point) => (direction === 'v' ? point.x * cos - point.y * sin : -point.x * sin + point.y * cos))
        .sort((left, right) => left - right);
    const thickness = across[Math.floor(across.length * 0.75)] - across[Math.floor(across.length * 0.25)];
    return { lean, thickness: Number.isFinite(thickness) && thickness >= 4 ? thickness : 0 };
}

/** The page box a rotated label covers, so the erase and the label agree. */
function tightBounds(
    centreX: number,
    centreY: number,
    length: number,
    thickness: number,
    angle: number,
    direction: 'v' | 'h',
): { x: number; y: number; width: number; height: number } {
    const width = direction === 'v' ? thickness : length;
    const height = direction === 'v' ? length : thickness;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    return {
        x: centreX - (width * cos + height * sin) / 2,
        y: centreY - (width * sin + height * cos) / 2,
        width: width * cos + height * sin,
        height: width * sin + height * cos,
    };
}

/**
 * Give every leaned entry a rotated frame and a glyph size that matches the
 * ink it replaces.
 *
 * The reader reports a leaned column as direction "v" with no angle, and its
 * box is axis aligned: the width of that box is the glyph plus the whole run's
 * lean, so a 22 pixel glyph became a 78 pixel frame and a 57 pixel font. The
 * ink is not ambiguous. The lean comes from the segmentation plane, and the
 * frame is a rectangle of that lean: its thickness is the glyph, its length is
 * the column run measured along the lean. When several entries share one blue
 * rectangle, the rectangle is split across the reading axis first, because a
 * frame wide enough for two columns is a frame for neither.
 *
 * An entry the mask cannot measure keeps the reader's own lean or stays
 * upright: a made-up angle is worse than no angle.
 */
export function applyInclination(
    regions: BlockRegion[],
    boxes: { x: number; y: number; width: number; height: number }[],
    mask: TextMask | null,
    /**
     * Lean measured from the ink of the whole block, when the block was cut
     * into columns and each of them was read upright. The segmentation plane
     * cannot measure it on a box that holds several columns: it returns the
     * diagonal of the run (down to the left on a three column speech) with the
     * opposite sign to the columns, which drew the label about 20 degrees the
     * wrong way.
     */
    blockLean?: number,
): void {
    if (regions.length === 0) return;
    const byBox = new Map<number, BlockRegion[]>();
    for (const region of regions) {
        const id = (region.boxIds ?? []).find((value) => value >= 1 && value <= boxes.length);
        if (id === undefined) continue;
        const list = byBox.get(id);
        if (list) list.push(region);
        else byBox.set(id, [region]);
    }
    const claimed = new Set<BlockRegion>();
    for (const [id, group] of byBox) {
        group.forEach((region) => claimed.add(region));
        const box = boxes[id - 1];
        const direction = group[0].direction;
        const measured = leanOfBox(mask, box, direction);
        const groupLean = direction === 'v' && blockLean !== undefined ? blockLean : measured?.lean ?? 0;
        const acrossStart = direction === 'v' ? box.x : box.y;
        const acrossSize = direction === 'v' ? box.width : box.height;
        const alongStart = direction === 'v' ? box.y : box.x;
        const alongSize = direction === 'v' ? box.height : box.width;
        const inkEm = measured?.thickness && measured.thickness >= 4 ? measured.thickness : undefined;
        // The glyph is measured from the page, not read off the grid by the
        // model: on the cup page the reader answered 44 and then 13 for the same
        // 27 pixel column, so its arithmetic may be off by 2x either way.
        //
        // What is left is the box and the ink. The box the reader named is axis
        // aligned, so on a leaned column its width is the glyph *plus* the lean:
        // the 卒業証書 banner's box is 169 wide for a 60 pixel glyph. The tight
        // rectangle that fits in that box has thickness W·cos θ − H·sin θ, which
        // is the column — 169·0.964 − 358·0.267 = 67 on the banner, and simply
        // the width when nothing leans. That is only meaningful for a box that
        // holds one column: three entries in one box are a third of a column
        // each, and the band is the answer there.
        //
        // The ink's interquartile width caps it, while it is credible: the
        // segmentation plane misses a faint column, and a 12 pixel reading on a
        // 30 pixel box is the plane missing, not a 12 pixel glyph.
        const tight = group.length === 1
            ? Math.max(4, acrossSize * Math.cos(groupLean) - alongSize * Math.abs(Math.sin(groupLean)))
            : acrossSize / group.length;
        const credible = inkEm !== undefined && inkEm >= tight * 0.6;
        const boxEm = credible ? Math.min(tight, inkEm) : tight;
        if ((measured === undefined && blockLean === undefined) || Math.abs(groupLean) < 0.5 * Math.PI / 180) {
            // No ink measurement: an upright label is wrong but recoverable; a
            // label rotated by the reader's guess is wrong in a direction the
            // page never had, and looks like a deliberate slant. The glyph is
            // still measurable from the box, so the label keeps its size even
            // when the plane cannot say which way it leans.
            group.forEach((region) => {
                region.angle = undefined;
                region.glyphSize = boxEm;
                region.lineThickness = Math.max(4, Math.min(boxEm, acrossSize * 0.95));
            });
            continue;
        }

        const ordered = [...group].sort((left, right) => {
            const ownLeft = left.own ?? left;
            const ownRight = right.own ?? right;
            const acrossOf = (item: { x: number; y: number; width: number; height: number }): number => (
                direction === 'v' ? item.x + item.width / 2 : item.y + item.height / 2
            );
            return direction === 'v'
                ? acrossOf(ownRight) - acrossOf(ownLeft)
                : acrossOf(ownLeft) - acrossOf(ownRight);
        });
        const band = acrossSize / ordered.length;
        ordered.forEach((region, index) => {
            const centreAcross = direction === 'v'
                ? acrossStart + acrossSize - band * (index + 0.5)
                : acrossStart + band * (index + 0.5);
            const centreAlong = alongStart + alongSize / 2;
            const lean = groupLean;
            const cos = Math.max(0.5, Math.cos(lean));
            const length = alongSize / cos;
            const em = boxEm;
            const thickness = Math.max(4, Math.min(em, band * 0.95));
            const bounds = tightBounds(centreAcross, centreAlong, length, thickness, lean, direction);
            region.x = bounds.x;
            region.y = bounds.y;
            region.width = bounds.width;
            region.height = bounds.height;
            region.angle = lean;
            region.lineLength = length;
            region.lineThickness = thickness;
            region.glyphSize = thickness;
            region.frame = { ...bounds };
        });
    }
    // A region with no named box still has its own box. Measure the ink there
    // rather than leaving a leaned line upright: the own box is axis aligned,
    // but the seg plane's major axis inside it is the column's direction.
    for (const region of regions) {
        if (claimed.has(region)) continue;
        const own = region.own ?? region;
        const measured = leanOfBox(mask, own, region.direction);
        if (!measured || Math.abs(measured.lean) < 0.5 * Math.PI / 180) {
            region.angle = undefined;
            continue;
        }
        const lean = measured.lean;
        const length = (region.direction === 'v' ? own.height : own.width) / Math.max(0.5, Math.cos(lean));
        const em = region.glyphSize && region.glyphSize >= 4
            ? Math.min(region.glyphSize, measured.thickness || region.glyphSize)
            : measured.thickness || (region.direction === 'v' ? own.width : own.height);
        const thickness = Math.max(4, Math.min(em, (region.direction === 'v' ? own.width : own.height) * 0.95));
        const bounds = tightBounds(
            own.x + own.width / 2,
            own.y + own.height / 2,
            length,
            thickness,
            lean,
            region.direction,
        );
        region.x = bounds.x;
        region.y = bounds.y;
        region.width = bounds.width;
        region.height = bounds.height;
        region.angle = lean;
        region.lineLength = length;
        region.lineThickness = thickness;
        region.glyphSize = thickness;
        region.frame = { ...bounds };
    }
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
    /** Segmentation plane, used to measure the lean the reader did not report. */
    mask: TextMask | null = null,
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
            // Only the detector's line boxes that reach this block: they are
            // what the prompt calls the text to read, so a stray box from the
            // panel next door must not appear on the crop.
            const inside = columnBoxes(detBoxes.filter((box) => (
                box.x < padded.x + padded.width && box.x + box.width > padded.x
                && box.y < padded.y + padded.height && box.y + box.height > padded.y
            )).slice(0, 40).map((box) => ({ x: box.x, y: box.y, width: box.width, height: box.height })));
            reading.boxes = inside;
            // Every box drawn on the crop is shown whole: a box cut by the crop
            // edge is the one a reader tends to leave out of its answer, and
            // that unread column is what a block-wide erase used to blank. The
            // crop the reader is shown is the erase box plus the ruler strip,
            // so its origin is what the grid's numbers are counted from.
            let cut: { dataUrl: string; crop: { x: number; y: number; width: number; height: number }; cell: number };
            try {
                cut = blockCropDataUrl(bitmap, bitmap.width, bitmap.height, reading.block, inside);
            } catch (cause) {
                console.warn('Block reading could not cut one block.', cause);
                continue;
            }
            const crop = { ...cut.crop, score: reading.block.score };
            const dataUrl = cut.dataUrl;
            // The same crop, read on the device first: the columns are found
            // from the ink and each one is transcribed alone, which is the one
            // thing a leaned, small column needs. The reading goes into the
            // prompt as a reference and never becomes the answer.
            let hint: BlockHint | null = null;
            try {
                hint = await readBlockHint(bitmap, reading.block, mask, inside.length);
                if (hint) {
                    console.info(`[hint] block ${index + 1}: ${hint.columns} column(s) at `
                        + `${(hint.lean * 180 / Math.PI).toFixed(1)}deg: `
                        + hint.lines.map((line) => `${line.text}(${line.confidence.toFixed(2)})`).join(' | '));
                }
            } catch (cause) {
                console.warn('The on-device reading of one block failed.', cause);
            }
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    const content = await deepSeekContentForSync(ocr.key, [dataUrl], blockPrompt(hint), READ_EFFORT);
                    reading.raw = content;
                    if (hint) reading.hint = hint;
                    console.info(`[read] block ${index + 1}: ${content.slice(0, 3000)}`);
                    reading.cropUrl = dataUrl;
                    const parsed = readBlockAnswer(content, crop, cut.cell, reading.boxes ?? []);
                    const kept = dropReadingsInsideColumns(parsed);
                    if (kept.length !== parsed.length) {
                        console.info(`[read] dropped ${parsed.length - kept.length} reading(s) inside a column`);
                    }
                    reading.regions = separateOverlaps(mergeCompanionRegions(kept));
                    // The frame each label will be drawn on, decided here where
                    // the boxes drawn on the crop and the entries are both in
                    // hand: the label goes on the ink, not on the estimate.
                    const frames = blockFrames(reading.regions, reading.boxes ?? []);
                    reading.regions.forEach((region, at) => {
                        const frame = frames[at];
                        if (frame) region.frame = frame;
                    });
                    // The reader answers "v" for a column that leans. Measure
                    // the lean from the ink and give the entry the rotated
                    // frame and the glyph size the label needs.
                    applyInclination(reading.regions, reading.boxes ?? [], mask, hint?.lean);
                    const geometry = gridGeometry(cut.crop, cut.cell);
                    reading.cell = geometry.cell;
                    console.info(`[grid] block ${index + 1}: ${geometry.columns} x ${geometry.rows} cells `
                        + `of ${reading.cell}px, ${reading.regions.length} line(s)`);
                    // A box the reader left out is text that will get no
                    // translation. Naming it here is what makes the next blank
                    // balloon traceable to the reading pass instead of the fit.
                    if (reading.regions.length < inside.length) {
                        console.warn(`[read] block ${index + 1}: ${reading.regions.length} line(s) for `
                            + `${inside.length} box(es); the rest keep their ink`);
                    }
                    break;
                } catch (cause) {
                    if (attempt === 0) {
                        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
                        continue;
                    }
                    console.warn('Block reading failed for one block.', cause,
                        JSON.stringify((reading.raw ?? '').slice(0, 160)));
                }
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()));
    // Two blocks over the same ink are two readings of it: the ones that came
    // back as a repeat are dropped before the caller builds groups, so a plate
    // read twice cannot be translated twice.
    return dropRepeatedReadings(readings);
}
