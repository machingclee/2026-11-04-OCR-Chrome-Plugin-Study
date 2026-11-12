import { DETECTOR_INPUT_SIZE } from '../shared/constants';
import type { Box, TextMask } from './types';

const INK = 0.3;

function inkAt(mask: TextMask, x: number, y: number): number {
    const mx = Math.round(x * mask.scale + mask.padX);
    const my = Math.round(y * mask.scale + mask.padY);
    if (mx < 0 || my < 0 || mx >= DETECTOR_INPUT_SIZE || my >= DETECTOR_INPUT_SIZE) return 0;
    return mask.data[my * DETECTOR_INPUT_SIZE + mx];
}

type Run = { start: number; end: number; peak: number };

/**
 * A short ruby sometimes sits so close to its host that the detector returns one
 * box for both columns. The seg mask still separates them: the host is the wide,
 * strong column and the reading is a thin column beside it. Trim the box to the
 * host so OCR never sees both readings as one line.
 */
export function trimMergedRuby<T extends Box & { direction?: 'vertical' | 'horizontal' }>(
    line: T,
    mask: TextMask | null,
): T {
    if (!mask) return line;
    const vertical = (line.direction ?? (line.height >= line.width ? 'vertical' : 'horizontal')) === 'vertical';
    const crossStart = Math.floor(vertical ? line.x : line.y);
    const crossEnd = Math.ceil(vertical ? line.x + line.width : line.y + line.height);
    if (crossEnd - crossStart < 4) return line;

    const alongStart = Math.floor(vertical ? line.y : line.x);
    const alongEnd = Math.ceil(vertical ? line.y + line.height : line.x + line.width);
    const counts: Array<{ position: number; count: number }> = [];
    for (let cross = crossStart; cross < crossEnd; cross += 1) {
        let count = 0;
        for (let along = alongStart; along < alongEnd; along += 1) {
            const x = vertical ? cross : along;
            const y = vertical ? along : cross;
            if (inkAt(mask, x, y) >= INK) count += 1;
        }
        counts.push({ position: cross, count });
    }

    const runs: Run[] = [];
    let current: Run | null = null;
    for (const entry of counts) {
        if (entry.count >= 1) {
            if (!current) current = { start: entry.position, end: entry.position, peak: entry.count };
            else {
                current.end = entry.position;
                current.peak = Math.max(current.peak, entry.count);
            }
        } else if (current) {
            runs.push(current);
            current = null;
        }
    }
    if (current) runs.push(current);

    // A one-pixel seam can split one glyph column; keep only real gaps.
    const mergedRuns: Run[] = [];
    for (const run of runs) {
        const previous = mergedRuns[mergedRuns.length - 1];
        if (previous && run.start - previous.end <= 3) {
            previous.end = run.end;
            previous.peak = Math.max(previous.peak, run.peak);
        } else {
            mergedRuns.push({ ...run });
        }
    }
    if (mergedRuns.length < 2) return line;

    const host = [...mergedRuns].sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
    const hostExtent = host.end - host.start + 1;
    const readings = mergedRuns.filter((run) => {
        if (run === host) return false;
        const extent = run.end - run.start + 1;
        const gap = Math.max(0, Math.max(run.start, host.start) - Math.min(run.end, host.end));
        return extent <= hostExtent * 0.7
            && run.peak <= host.peak * 0.65
            && gap <= hostExtent * 1.5;
    });
    if (readings.length === 0) return line;

    const pad = 2;
    if (vertical) {
        const x = Math.max(line.x, host.start - pad);
        const right = Math.min(line.x + line.width, host.end + 1 + pad);
        return { ...line, x, width: Math.max(1, right - x) };
    }
    const y = Math.max(line.y, host.start - pad);
    const bottom = Math.min(line.y + line.height, host.end + 1 + pad);
    return { ...line, y, height: Math.max(1, bottom - y) };
}
