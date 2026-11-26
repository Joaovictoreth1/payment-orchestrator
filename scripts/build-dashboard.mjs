import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

const outdir = 'dist/public';
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: { dashboard: 'frontend/Dashboard.jsx' },
  bundle: true,
  minify: true,
  jsx: 'automatic',
  outdir,
  platform: 'browser',
});
await copyFile('frontend/index.html', `${outdir}/index.html`);
