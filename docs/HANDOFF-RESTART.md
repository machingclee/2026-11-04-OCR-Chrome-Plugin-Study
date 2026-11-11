# Handoff: restart the inpainting

Scope: the erase only. The detector is good and the text boxes are trusted. Do not
change detection, grouping, translation, or typesetting in this pass.

## Repo

```
/Users/chingcheonglee/Repos/Javascript/2026-11-04-OCR-Chrome-Plugin-Study
branch step-10-typeset-quality
```

## What exists right now

The erase is a white rectangle over every line box, drawn in the offscreen
document, in `src/offscreen/main.ts`:

```ts
context.fillStyle = '#ffffff';
for (const line of lines) {
    context.fillRect(line.x - 2, line.y - 2, line.width + 4, line.height + 4);
    for (const ruby of line.ruby) {
        context.fillRect(ruby.x - 2, ruby.y - 2, ruby.width + 4, ruby.height + 4);
    }
}
```

It is reliable and ugly. That rectangle is what the next attempt replaces.

## Inputs the erase already has

| Name | Shape | Space |
| --- | --- | --- |
| `bitmap` | page | page pixels |
| `lines` | `Box[]` with `ruby` | page pixels |
| `detected.mask` | `seg`, 1024 square | letterboxed page |
| balloons | `x, y, w, h`, `shape` 160 square | page pixels, then 640 letterboxed |

Three spaces. Every previous failure came from converting between them by hand.

## What went wrong before

1. Sampling `seg` per page pixel and filling where it fires. Where the mapping was
   off by a page offset, the whole page was treated as a glyph and turned white.
2. The AOT model, once at 512 and once tiled. Both filled large areas, because the
   mask handed to the model was in the wrong space.
3. A refined mask with per line dilation. Right page empty, because the offset was
   added instead of subtracted.

The models are deleted. `src/lib/inpaint.ts`, `src/lib/mask.ts`, and
`src/lib/erase.ts` are still in the tree but unused.

## A restart that cannot go white

The reason the page turned white is that a mask was used as the source of truth
for pixels. The restart should treat the line box as the source of truth, because
the boxes are known to be good.

### Step one: fill each box with the paper colour around it

For each line box, expand it by eight percent, sample the pixels on that border,
take the median colour, and fill the inner box with it.

```ts
function paperColour(image: ImageData, box: Box): [number, number, number] {
    // walk the ring of the expanded box, collect pixels, return the median
}
```

On a white balloon this returns white. Inside a grey screentone it returns the
grey of that tone, which is already better than the current white rectangle.

### Step two: feather the edge

A hard rectangle reads as a sticker. Blend the last two pixels of the fill into
the page, so the patch has a soft edge. That alone removes most of the "unusable"
feeling.

### Step three: only then consider texture

If a balloon sits on screentone or on artwork, a flat patch still shows. Two
cheap options before any model:

- mirror the pixels just outside the box into it,
- copy a patch of the same size from the nearest area with a similar mean colour.

Both are a few dozen lines and need no assets.

### Step four: a model, if still needed

The reference implementation uses `aot_inpaint_512.onnx`, 22,749,561 bytes,
sha256 `acdddccf…`, in a single 512 pass over the whole page. Two settings matter:
normalise to minus one to one, and set the hole to zero **after** normalising. If
this stage is attempted, write one function that converts a page point into the
model grid and use it everywhere:

```ts
toModel(x, y) => ({
    x: (x - cropX) * scale + padX,
    y: (y - cropY) * scale + padY,
});
```

Never write that arithmetic inline twice.

## Definition of done

1. No white rectangle is visible outside a text box.
2. On a white balloon the patch is invisible at a glance.
3. On a grey tone the patch keeps the tone, even if the texture is flat.
4. A full pass stays under ten seconds for a 1500 by 1100 page.
5. The popup shows the same image that the erase produced.

## How to look at the result

```bash
npm run build
```

Reload the extension, press Detect boxes, open `Show stages`. The first image is
the erased page. That image is the only honest signal for this task.

## Do not touch

- `src/lib/detector.ts`
- `src/lib/readingOrder.ts`
- `src/lib/typeset.ts`
- the popup layout

If a change seems to need one of those, it is a different task.
