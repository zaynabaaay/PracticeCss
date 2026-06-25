#!/usr/bin/env node
'use strict';

const { chromium } = require('playwright');
const { parseArgs } = require('node:util');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function usage() {
  console.log(`
anim2mp4 — render a deterministic HTML/CSS/JS animation to MP4

Usage:
  node capture.js --html <path-or-url> --out <output.mp4> [options]

Required:
  --html <path|url>      Local file path (or file:// / http(s):// URL) of the page to render
  --out <path>            Output .mp4 path

Options:
  --width <px>            Viewport width            (default 1280)
  --height <px>           Viewport height           (default 720)
  --fps <n>                Frames per second         (default 30)
  --duration <seconds>     Total animation length. Overrides window.Anim.duration if set
  --start-time <seconds>   First frame's time value  (default 0)
  --frames-dir <path>      Where to write PNG frames (default: a temp dir)
  --keep-frames            Keep the PNG sequence after encoding (default: delete)
  --crf <n>                libx264 quality, lower = better (default 18)
  --allow-css-motion       Don't pause CSS animations/transitions before capture
  --wait-timeout <ms>      How long to wait for window.Anim to appear (default 10000)
  -h, --help               Show this help

The target page must expose a global "window.Anim" object:

  window.Anim = {
    duration: 4.5,          // seconds (optional if --duration is passed)
    setTime(t) { ... },     // sync: move every object to its state at time t (seconds)
    ready: Promise.resolve()// optional: capture waits for this before frame 0
  };

See README.md for the full contract.
`);
}

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      html: { type: 'string' },
      out: { type: 'string' },
      width: { type: 'string', default: '1280' },
      height: { type: 'string', default: '720' },
      fps: { type: 'string', default: '30' },
      duration: { type: 'string' },
      'start-time': { type: 'string', default: '0' },
      'frames-dir': { type: 'string' },
      'keep-frames': { type: 'boolean', default: false },
      crf: { type: 'string', default: '18' },
      'allow-css-motion': { type: 'boolean', default: false },
      'wait-timeout': { type: 'string', default: '10000' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  return values;
}

function resolveHtmlTarget(htmlArg) {
  if (/^https?:\/\//.test(htmlArg) || /^file:\/\//.test(htmlArg)) {
    return htmlArg;
  }
  const abs = path.resolve(process.cwd(), htmlArg);
  if (!fs.existsSync(abs)) {
    throw new Error(`HTML file not found: ${abs}`);
  }
  return `file://${abs}`;
}

async function runFfmpeg({ framesDir, fps, outPath, crf }) {
  await fsp.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  const args = [
    '-y',
    '-framerate', String(fps),
    '-i', path.join(framesDir, 'frame_%06d.png'),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', String(crf),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outPath,
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
    });
  });
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.help || !args.html || !args.out) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const width = parseInt(args.width, 10);
  const height = parseInt(args.height, 10);
  const fps = parseInt(args.fps, 10);
  const startTime = parseFloat(args['start-time']);
  const waitTimeout = parseInt(args['wait-timeout'], 10);
  const crf = parseInt(args.crf, 10);
  const cliDuration = args.duration !== undefined ? parseFloat(args.duration) : undefined;

  const url = resolveHtmlTarget(args.html);
  const outPath = path.resolve(process.cwd(), args.out);

  const framesDir = args['frames-dir']
    ? path.resolve(process.cwd(), args['frames-dir'])
    : await fsp.mkdtemp(path.join(os.tmpdir(), 'anim2mp4-'));
  await fsp.mkdir(framesDir, { recursive: true });

  console.log(`Loading ${url} at ${width}x${height} ...`);

  const browser = await chromium.launch({
    executablePath: fs.existsSync('/opt/pw-browsers/chromium')
      ? '/opt/pw-browsers/chromium'
      : undefined,
  });
  const page = await browser.newPage({ viewport: { width, height } });

  // Lets pages tell a live-preview rAF loop (for viewing in a normal
  // browser) apart from a deterministic capture run, so the two don't
  // fight over window.Anim.setTime() calls.
  await page.addInitScript(() => {
    window.__ANIM2MP4_CAPTURE__ = true;
  });

  if (!args['allow-css-motion']) {
    // Freeze any incidental CSS-driven motion; the page should be moving
    // objects exclusively through window.Anim.setTime(), not real-time
    // transitions/animations that could leak between captured frames.
    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.textContent = `
        *, *::before, *::after {
          animation-play-state: paused !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
        }
      `;
      document.addEventListener('DOMContentLoaded', () => {
        document.head.appendChild(style);
      });
    });
  }

  await page.goto(url, { waitUntil: 'load' });

  await page.waitForFunction(
    () => typeof window.Anim === 'object' && typeof window.Anim.setTime === 'function',
    null,
    { timeout: waitTimeout }
  );

  // If the page needs to finish async setup (fonts, images, etc.) before
  // frame 0 is meaningful, it can expose window.Anim.ready as a Promise.
  await page.evaluate(async () => {
    if (window.Anim.ready && typeof window.Anim.ready.then === 'function') {
      await window.Anim.ready;
    }
  });

  const duration = cliDuration ?? await page.evaluate(() => window.Anim.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(
      'Could not determine animation duration. Pass --duration <seconds> or set window.Anim.duration on the page.'
    );
  }

  const frameCount = Math.max(1, Math.round((duration - startTime) * fps));
  console.log(`Capturing ${frameCount} frames (${duration}s @ ${fps}fps) -> ${framesDir}`);

  for (let i = 0; i < frameCount; i++) {
    const t = startTime + i / fps;
    await page.evaluate((t) => window.Anim.setTime(t), t);
    const framePath = path.join(framesDir, `frame_${String(i + 1).padStart(6, '0')}.png`);
    await page.screenshot({ path: framePath, type: 'png' });
    if ((i + 1) % fps === 0 || i + 1 === frameCount) {
      process.stdout.write(`  frame ${i + 1}/${frameCount}\r`);
    }
  }
  process.stdout.write('\n');

  await browser.close();

  console.log('Encoding with ffmpeg...');
  await runFfmpeg({ framesDir, fps, outPath, crf });
  console.log(`Wrote ${outPath}`);

  if (!args['keep-frames']) {
    await fsp.rm(framesDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
