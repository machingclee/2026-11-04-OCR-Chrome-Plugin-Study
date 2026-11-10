"""Print what the detector actually outputs, without a browser.

The article claims the model ships three maps and that the det map returns lines
while the seg map returns single glyphs. This script checks that claim.

    python3 scripts/probe-detector-outputs.py --image page.png
    python3 scripts/probe-detector-outputs.py            # draws its own page

Requires onnxruntime, numpy, and Pillow: pip install onnxruntime numpy pillow
"""

import argparse
from collections import deque
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageFont

INPUT_SIZE = 1024
THRESHOLD = 0.3
MIN_AREA = 20


def draw_page(width: int = 900, height: int = 1200) -> Image.Image:
    font_path = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
    font = ImageFont.truetype(font_path, 44)
    small = ImageFont.truetype(font_path, 22)

    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)

    for column, text in ((520, "死んでも"), (460, "放すなよ")):
        for index, char in enumerate(text):
            draw.text((column, 150 + index * 48), char, font=font, fill="black")
    draw.text((560, 150), "し", font=small, fill="black")
    draw.text((150, 700), "前はいっばい入れてた", font=font, fill="black")
    return image


def letterbox(image: Image.Image) -> tuple[np.ndarray, float, int, int]:
    width, height = image.size
    scale = min(INPUT_SIZE / width, INPUT_SIZE / height)
    target = (max(1, round(width * scale)), max(1, round(height * scale)))
    pad_x = (INPUT_SIZE - target[0]) // 2
    pad_y = (INPUT_SIZE - target[1]) // 2

    canvas = Image.new("RGB", (INPUT_SIZE, INPUT_SIZE), (0, 0, 0))
    canvas.paste(image.resize(target, Image.BILINEAR), (pad_x, pad_y))
    array = np.asarray(canvas, dtype=np.float32) / 255.0
    return array.transpose(2, 0, 1)[None], scale, pad_x, pad_y


def blobs(mask: np.ndarray) -> list[tuple[int, int, int, int, int]]:
    size = mask.shape[0]
    seen = np.zeros_like(mask, dtype=bool)
    found = []

    for y in range(size):
        for x in range(size):
            if not mask[y, x] or seen[y, x]:
                continue
            queue = deque([(x, y)])
            seen[y, x] = True
            min_x = max_x = x
            min_y = max_y = y
            count = 0
            while queue:
                current_x, current_y = queue.pop()
                count += 1
                min_x, max_x = min(min_x, current_x), max(max_x, current_x)
                min_y, max_y = min(min_y, current_y), max(max_y, current_y)
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        next_x, next_y = current_x + dx, current_y + dy
                        if 0 <= next_x < size and 0 <= next_y < size:
                            if mask[next_y, next_x] and not seen[next_y, next_x]:
                                seen[next_y, next_x] = True
                                queue.append((next_x, next_y))
            if count >= MIN_AREA:
                found.append((min_x, min_y, max_x - min_x + 1, max_y - min_y + 1, count))
    return found


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="public/models/comictextdetector.pt.onnx")
    parser.add_argument("--image")
    parser.add_argument("--unclip", type=float, default=1.5)
    args = parser.parse_args()

    image = Image.open(args.image).convert("RGB") if args.image else draw_page()
    tensor, scale, pad_x, pad_y = letterbox(image)

    session = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    names = [output.name for output in session.get_outputs()]
    values = session.run(None, {session.get_inputs()[0].name: tensor})
    outputs = dict(zip(names, values))

    print("outputs")
    for name in names:
        array = np.asarray(outputs[name])
        print(f"  {name}: {list(array.shape)}")

    for name, array in outputs.items():
        block = np.asarray(array)
        if block.ndim != 4:
            print(f"{name}: {block.shape[1]} rows of features, not a map")
            continue
        for channel in range(block.shape[1]):
            plane = block[0, channel]
            print(
                f"{name} channel {channel}: min={plane.min():.3f} max={plane.max():.3f}"
                f" above threshold={float((plane > THRESHOLD).mean()):.3f}"
            )

    print("\nwhat one blob covers")
    for name, channel in (("seg", 0), ("det", 0)):
        plane = np.asarray(outputs[name])[0, channel]
        found = blobs(plane > THRESHOLD)
        print(f"  {name} channel {channel}: {len(found)} blobs")

    print("\nlines after unclip")
    for min_x, min_y, width, height, _ in sorted(blobs(np.asarray(outputs["det"])[0, 0] > THRESHOLD), key=lambda b: (b[1], b[0])):
        distance = (width * height * args.unclip) / (2 * (width + height))
        source = (
            (min_x - distance - pad_x) / scale,
            (min_y - distance - pad_y) / scale,
            (width + 2 * distance) / scale,
            (height + 2 * distance) / scale,
        )
        print(f"  x={source[0]:7.1f} y={source[1]:7.1f} w={source[2]:6.1f} h={source[3]:6.1f}")


if __name__ == "__main__":
    main()
