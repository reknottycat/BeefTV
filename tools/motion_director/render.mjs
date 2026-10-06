import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const directory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
if (args.includes('--help')) {
  console.log('node tools/motion_director/render.mjs --stack <existing Remotion project> --input <compiled input.json> --out <new output.mp4> --work-dir <new disposable directory> [--audio <48k PCM WAV>] [--concurrency 2]');
  process.exit(0);
}
for (const name of ['--stack', '--input', '--out', '--work-dir']) if (!option(name)) throw new Error(`Missing ${name}; use --help`);
const stack = path.resolve(option('--stack'));
const inputFile = path.resolve(option('--input'));
const output = path.resolve(option('--out'));
const work = path.resolve(option('--work-dir'));
if (fs.existsSync(output)) throw new Error(`Output already exists: ${output}`);
if (fs.existsSync(work)) throw new Error(`Work directory already exists: ${work}`);
const input = JSON.parse(fs.readFileSync(inputFile, 'utf8').replace(/^\uFEFF/, ''));
if (input.timeline?.schemaVersion !== 1 || !Number.isInteger(input.timeline.totalFrames) || input.timeline.totalFrames < 1) throw new Error('Expected a compiled DirectorTimeline version 1');
let boundary = 0;
for (const shot of input.timeline.shots) {
  if (shot.startFrame !== boundary || shot.endFrame - shot.startFrame !== shot.durationFrames || !shot.direction) throw new Error(`Non-executable or discontinuous shot ${shot.shotId}`);
  boundary = shot.endFrame;
}
if (boundary !== input.timeline.totalFrames) throw new Error('Shot coverage differs from totalFrames');
fs.mkdirSync(work, {recursive: true});
fs.mkdirSync(path.dirname(output), {recursive: true});
const require = createRequire(path.join(stack, 'package.json'));
const {bundle} = require('@remotion/bundler');
const {openBrowser, getCompositions, renderMedia, renderStill} = require('@remotion/renderer');
const nm = path.join(stack, 'node_modules');
const browserExecutable = option('--browser', path.join(nm, '.remotion/chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe'));
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (bin, argv) => {
  const result = spawnSync(bin, argv, {shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 30e6});
  if (result.error || result.status !== 0) throw new Error(`${bin} failed: ${result.error?.message ?? result.stderr}`);
  return result;
};
const sources = ['remotion-entry.tsx', 'continuity-view.tsx', 'render.mjs'].map((name) => path.join(directory, name)).concat(['director-motion.ts', 'director-timeline.ts'].map((name) => path.resolve(directory, '../../web/src/lib/canvas/director', name)));
const evidence = {schemaVersion: 1, started: new Date().toISOString(), inputSHA256: hash(inputFile), codeHashes: sources.map((file) => ({path: file, sha256: hash(file)})), remotionVersion: require('remotion/package.json').version, browserExecutable, concurrency: Number(option('--concurrency', '2')), gl: 'swiftshader', requestedEncoder: 'h264_nvenc', status: 'started', actualContentListening: false, actualDynamicVisualReview: false, records: []};
const record = () => fs.writeFileSync(path.join(work, 'render-receipt.json'), JSON.stringify(evidence, null, 2) + '\n');
record();
let browser;
try {
  // NVENC is a hard requirement. This preflight prevents an unnoticed CPU fallback.
  run('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=1280x720:r=30', '-t', '0.1', '-c:v', 'h264_nvenc', '-f', 'null', '-']);
  const serveUrl = await bundle({entryPoint: path.join(directory, 'remotion-entry.tsx'), rootDir: directory, outDir: path.join(work, 'bundle'), enableCaching: false,
    webpackOverride: (config) => ({...config, resolve: {...config.resolve, modules: [nm, ...(config.resolve.modules ?? [])], alias: {...config.resolve.alias, react: path.join(nm, 'react'), 'react-dom': path.join(nm, 'react-dom'), remotion: path.join(nm, 'remotion')}}, resolveLoader: {...config.resolveLoader, modules: [nm, ...(config.resolveLoader?.modules ?? [])]}})});
  const chromiumOptions = {gl: 'swiftshader', headless: true};
  browser = await openBrowser('chrome', {browserExecutable, chromiumOptions});
  const common = {serveUrl, browserExecutable, chromiumOptions, puppeteerInstance: browser, inputProps: input, timeoutInMilliseconds: 120000};
  const composition = (await getCompositions(common)).find((item) => item.id === 'DirectorMotion');
  if (!composition || composition.durationInFrames !== input.timeline.totalFrames) throw new Error('Compiled timeline differs from actual composition');
  evidence.composition = {id: composition.id, width: composition.width, height: composition.height, fps: composition.fps, durationInFrames: composition.durationInFrames};
  const samples = [...new Set([0, ...input.timeline.shots.flatMap((shot) => [shot.startFrame + Math.min(24, shot.durationFrames - 1), shot.endFrame - 1]), composition.durationInFrames - 1])];
  const stills = path.join(work, 'stills'); fs.mkdirSync(stills);
  for (const frame of samples) {
    const target = path.join(stills, `frame-${String(frame).padStart(6, '0')}.png`);
    await renderStill({...common, composition, frame, output: target, overwrite: false});
    evidence.records.push({kind: 'actual_remotion_still', frame, path: target, sha256: hash(target)});
  }
  const silent = path.join(work, 'silent-nvenc.mp4');
  evidence.status = 'rendering'; record();
  let last = 0;
  await renderMedia({...common, composition, outputLocation: silent, codec: 'h264', hardwareAcceleration: 'required', videoBitrate: '8M', concurrency: evidence.concurrency, muted: true, overwrite: false, imageFormat: 'jpeg', jpegQuality: 95, pixelFormat: 'yuv420p',
    ffmpegOverride: ({args: ffargs, type}) => {
      const current = ffargs.includes('-c:v') ? ffargs[ffargs.indexOf('-c:v') + 1] : undefined;
      if (current && current !== 'copy') evidence.actualEncoder = current;
      evidence.encoderCommands ??= [];
      evidence.encoderCommands.push({type, args: ffargs});
      fs.writeFileSync(path.join(work, 'encoder-command.json'), JSON.stringify(evidence.encoderCommands, null, 2));
      return ffargs;
    },
    onProgress: (progress) => {if (Date.now() - last > 10000) {last = Date.now(); console.log(JSON.stringify({renderedFrames: progress.renderedFrames, encodedFrames: progress.encodedFrames, totalFrames: composition.durationInFrames}));}}
  });
  if (evidence.actualEncoder !== 'h264_nvenc') throw new Error(`GPU encoding differs: ${evidence.actualEncoder}`);
  const audio = option('--audio');
  if (audio) {
    run('ffmpeg', ['-hide_banner', '-v', 'error', '-n', '-i', silent, '-i', path.resolve(audio), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-t', String(composition.durationInFrames / composition.fps), '-movflags', '+faststart', output]);
    evidence.audioSourceSHA256 = hash(path.resolve(audio));
  } else fs.renameSync(silent, output);
  run('ffmpeg', ['-hide_banner', '-v', 'error', '-i', output, '-f', 'null', '-']);
  const metadata = JSON.parse(run('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', output]).stdout);
  const video = metadata.streams.find((item) => item.codec_type === 'video');
  if (Number(video.nb_read_frames) !== composition.durationInFrames) throw new Error('Encoded frame count differs');
  evidence.records.push({kind: 'decoded_output', path: output, sha256: hash(output), bytes: fs.statSync(output).size, metadata});
  evidence.status = 'rendered_full_decode_passed';
  evidence.finished = new Date().toISOString(); record();
  console.log(JSON.stringify({status: evidence.status, output, actualEncoder: evidence.actualEncoder, frames: video.nb_read_frames}));
} catch (error) {evidence.status = 'failed'; evidence.error = String(error); record(); throw error;}
finally {if (browser) await browser.close({silent: true});}
