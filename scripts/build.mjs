#!/usr/bin/env node
import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

mkdirSync(resolve(rootDir, 'dist'), { recursive: true });

await esbuild.build({
  entryPoints: [resolve(rootDir, 'index.ts')],
  outfile: resolve(rootDir, 'dist/index.js'),
  format: 'esm',
  target: 'node18',
  platform: 'node',
  bundle: true,
  external: ['openclaw', 'openclaw/plugin-sdk'],
  sourcemap: true,
  minify: false,
});

// Copy plugin manifest
copyFileSync(
  resolve(rootDir, 'openclaw.plugin.json'),
  resolve(rootDir, 'dist/openclaw.plugin.json')
);

console.log('Build complete!');
