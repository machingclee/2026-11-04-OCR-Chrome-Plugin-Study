import type { Box } from '../types';
import { cropSize, drawUpright } from '../warp';
import { OCR_INPUT_HEIGHT, OCR_INPUT_WIDTH, OCR_NORMALIZE } from '../../shared/constants';

/**
 * Shape one line for the recogniser. A vertical column turns 90 degrees so the
 * reading order becomes left to right, and the thicker side lands on the fixed
 * height of 32. The width pads to a multiple of 32, which is what the model saw
 * during training.
 */
export function buildOcrInput(
    bitmap: ImageBitmap,
    box: Box,
    vertical: boolean,
): { data: Float32Array; dims: number[]; width: number } {
    const size = cropSize(box);
    const thickness = vertical ? size.height : size.width;
    const length = vertical ? size.width : size.height;
    const scale = OCR_INPUT_HEIGHT / Math.max(1, thickness);
    const rawWidth = Math.max(1, Math.round(length * scale));
    const width = Math.min(OCR_INPUT_WIDTH, Math.ceil(rawWidth / 32) * 32);
    const contentWidth = Math.min(width, rawWidth);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = OCR_INPUT_HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The browser refused a 2D context for the crop.');

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, OCR_INPUT_HEIGHT);

    const upright = document.createElement('canvas');
    upright.width = Math.max(1, Math.round(length));
    upright.height = Math.max(1, Math.round(thickness));
    const uprightContext = upright.getContext('2d');
    if (!uprightContext) throw new Error('The browser refused a 2D context for the upright crop.');
    drawUpright(uprightContext, bitmap, box, upright.width, upright.height);

    if (vertical) {
        context.translate(0, OCR_INPUT_HEIGHT);
        context.rotate(-Math.PI / 2);
        context.drawImage(upright, 0, 0, upright.width, upright.height, 0, 0, OCR_INPUT_HEIGHT, contentWidth);
    } else {
        context.drawImage(upright, 0, 0, upright.width, upright.height, 0, 0, contentWidth, OCR_INPUT_HEIGHT);
    }

    const pixels = context.getImageData(0, 0, width, OCR_INPUT_HEIGHT).data;
    const plane = width * OCR_INPUT_HEIGHT;
    const data = new Float32Array(3 * plane);
    const offsetBase = OCR_NORMALIZE === 'minus_one' ? 127.5 : 255;
    const shift = OCR_NORMALIZE === 'minus_one' ? 1 : 0;
    for (let index = 0; index < plane; index += 1) {
        const offset = index * 4;
        data[index] = pixels[offset] / offsetBase - shift;
        data[plane + index] = pixels[offset + 1] / offsetBase - shift;
        data[2 * plane + index] = pixels[offset + 2] / offsetBase - shift;
    }

    return { data, dims: [1, 3, OCR_INPUT_HEIGHT, width], width };
}
