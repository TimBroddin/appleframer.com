# tools

## hero-sample-screenshot.html

Source for the "your screenshot" image in the landing hero
(`public/hero-screenshot.png`).

It is a mock app UI sized to 440x956 CSS pixels, which at a device scale
factor of 3 renders to 1320x2868 — the exact screenshot size of an iPhone
16 Pro Max, so AppleFramer auto-detects it like any real screenshot.

To regenerate both hero images:

1. Screenshot this file at 440x956 with `deviceScaleFactor: 3`.
2. Drop the result into AppleFramer and download the framed PNG. That
   output becomes `public/hero-framed.png`, cropped to its opaque bounds
   so the transparent margin does not throw off the caption alignment.
3. Downscale the raw screenshot to 134px wide for
   `public/hero-screenshot.png`.

The framed image is genuinely the tool's own output rather than a mockup
of it, which is the point — the hero shows what the app actually does.
