import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');

const extension = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
};

const webview = {
  entryPoints: ['media/main.ts'],
  bundle: true,
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
};

mkdirSync('dist', { recursive: true });
cpSync('media/styles.css', 'dist/styles.css');

if (watch) {
  const ctxs = await Promise.all([esbuild.context(extension), esbuild.context(webview)]);
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
}
