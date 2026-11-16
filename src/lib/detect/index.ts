import type { DetectionResult, TextMask } from '../types';
import { extractLineBoxes, type PageRect } from './lines';
import { isSessionReady, loadDetector, runDetector } from './inference';

export { isSessionReady, loadDetector };

export type DetectOptions = {
    /**
     * False skips the line extraction. The block path asks only for the blk
     * regions and the two planes, because the reader supplies the line boxes.
     */
    lines?: boolean;
};

/**
 * One detector pass turned into boxes.
 *
 * With line extraction on, the boxes come from the det head and the glyph
 * strokes. With it off, only the block head answers, and the det plane is kept
 * for the erase mask.
 */
export async function detectLines(
    bitmap: ImageBitmap,
    bubbles: PageRect[] = [],
    options: DetectOptions = {},
): Promise<DetectionResult> {
    const { det, seg, blocks, prepared } = await runDetector(bitmap);
    const letterbox = { scale: prepared.scale, padX: prepared.padX, padY: prepared.padY };
    const mask: TextMask | null = seg ? { data: seg, ...letterbox } : null;
    return {
        detBoxes: options.lines === false ? [] : extractLineBoxes({ det, seg, prepared, bubbles }),
        blkBoxes: blocks,
        mask,
        det: { data: det, ...letterbox },
    };
}
