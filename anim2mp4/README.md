# anim2mp4

Render a deterministic HTML/CSS/JS animation to an MP4 by driving a headless
Chromium page through an explicit timeline and stitching the resulting PNG
frames with ffmpeg. No scrolling, no page navigation — a fixed viewport,
objects move within it.

## The page contract

Your page must expose a single global:

```js
window.Anim = {
  duration: 4.5,           // total length in seconds (optional if you pass --duration)
  setTime(t) {              // called once per frame with t in seconds, 0..duration
    // Synchronously set every moving element's final state for time t.
    // Use inline style (transform/opacity/etc.) computed from t — not
    // CSS @keyframes or transitions, which run on wall-clock time and
    // won't reliably "snap" to an arbitrary t.
  },
  ready: Promise.resolve(), // optional: capture awaits this before frame 0
                             // (use it to wait on fonts/images/layout)
};
```

`setTime` should be a pure function of `t`: given the same `t` it must always
produce the same visual state. That's what makes per-frame capture
deterministic regardless of how long the real screenshot/encode takes.

By default, the capture script also force-pauses all CSS
animations/transitions on the page (`animation-play-state: paused`,
`transition-duration: 0s`) so any incidental CSS motion can't leak between
frames. Disable with `--allow-css-motion` if you intentionally rely on CSS
state (e.g. `:hover`) that isn't covered by `setTime`.

See `example/animation.html` for a minimal working page.

## Usage

```bash
cd anim2mp4
npm install
npx playwright install chromium   # only needed if Chromium isn't already present

node capture.js --html example/animation.html --out example/output.mp4 \
  --duration 4 --fps 30 --width 800 --height 450
```

Or via the npm script:

```bash
npm run example
```

## Options

| Flag | Default | Description |
|---|---|---|
| `--html <path|url>` | required | Local file path or URL of the page |
| `--out <path>` | required | Output `.mp4` path |
| `--width` | `1280` | Viewport width in px |
| `--height` | `720` | Viewport height in px |
| `--fps` | `30` | Frames per second |
| `--duration` | from `window.Anim.duration` | Total seconds; overrides the page's value |
| `--start-time` | `0` | Time value for the first frame |
| `--frames-dir` | temp dir | Where PNG frames are written |
| `--keep-frames` | off | Keep the PNG sequence after encoding |
| `--crf` | `18` | libx264 quality (lower = higher quality/bigger file) |
| `--allow-css-motion` | off | Skip pausing CSS animations/transitions |
| `--wait-timeout` | `10000` | ms to wait for `window.Anim` to appear |

## How it works

1. Launch headless Chromium at a fixed viewport (no scrolling/resizing).
2. Load the page, wait for `window.Anim.setTime` to exist, await `Anim.ready` if present.
3. For each frame `i`, compute `t = startTime + i / fps`, call
   `window.Anim.setTime(t)` inside the page, then screenshot the viewport to
   `frame_NNNNNN.png`.
4. Run `ffmpeg -framerate <fps> -i frame_%06d.png -c:v libx264 -pix_fmt yuv420p -movflags +faststart <out>.mp4`.
5. Delete the PNG sequence unless `--keep-frames` is passed.
