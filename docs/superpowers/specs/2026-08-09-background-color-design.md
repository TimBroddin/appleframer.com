# Background Color Setting — Design

**Date:** 2026-08-09
**Status:** Approved

## Problem

Framed screenshots export as PNGs with a transparent area around the device.
Users who want a solid backdrop have to composite one themselves in another
tool. This came up naturally while investigating issue #2, where the reporter
had to place the output on an orange background to make corner artifacts
visible.

## Scope

Add a user-selectable background color that fills the canvas behind the device
frame. Transparency remains the default so existing users see no change unless
they opt in.

Explicitly out of scope: padding around the device, gradient backgrounds, and
per-image background overrides. The setting is global, matching how the device
frame and filename pattern already work.

## State and persistence

`ScreenshotFramer` owns the state, following the existing `filenamePattern`
pattern:

```ts
const [backgroundColor, setBackgroundColor] = useState<string | null>(() => {
  const saved = localStorage.getItem('backgroundColor');
  return saved === 'transparent' || saved === null ? null : saved;
});
```

`null` means transparent; a `#rrggbb` string means a solid fill. An effect
persists it to `localStorage`, writing the literal `'transparent'` for `null`.

The value flows to `FramePreview` as a prop and into the batch
`renderFramedImage` function as an argument.

## Rendering

Both render paths (`FramePreview.tsx` for preview/single download,
`ScreenshotFramer.tsx` for batch ZIP export) get the same change: after sizing
and clearing the main canvas, and before any screenshot drawing, fill the
background.

```ts
ctx.clearRect(0, 0, canvas.width, canvas.height);
if (backgroundColor) {
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}
```

**Critical constraint:** the fill goes on the *main* canvas (`ctx`), never the
temp canvas (`tempCtx`).

The temp canvas is where the corner mask is applied and where the frame is
composited with `destination-out` to erase screenshot pixels hiding under the
device's rounded corner (the fix for issue #2). Filling the temp canvas would
make it fully opaque, defeating both the mask and the erase, and would
immediately regress the corner artifact.

Keeping the fill on the main canvas means it lands strictly behind the
composited result, so the background shows through the rounded corners exactly
as intended.

## UI

A "Background" section in the `FrameSettings` modal, styled to match the
existing sections:

- A **Transparent** toggle button, using the same `border-blue-500 bg-blue-50`
  selected treatment as other options.
- An `<input type="color">` swatch for visual picking.
- A hex text field for exact values.

Hex input is validated against `/^#[0-9a-f]{6}$/i`. Invalid or partial input is
held in local component state and not committed upward, so a half-typed value
like `#ff` never blanks the preview.

## Preview

The preview canvas carries the fill itself, so it renders accurately with no
extra work. When transparent is selected, a subtle CSS checkerboard sits behind
the preview canvas so users can distinguish transparency from a white fill.

## Verification

Using the headless-Chrome harness built for the issue #2 corner fix:

1. With a background color set, stray screenshot pixels under the frame's
   opaque corner arc remain **0** — no corner-fix regression.
2. The background color is present in the corner region, confirming it shows
   through the rounded corners.
3. With transparent selected, output is byte-identical to current `main`.

Plus manual checks: color persists across reload, batch ZIP export honors the
setting, and frames without masks still render correctly.
