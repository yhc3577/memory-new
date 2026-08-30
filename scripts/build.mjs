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
  external: ['openclaw', 'openclaw/plugin-sdk', 'better-sqlite3'],
  sourcemap: true,
  minify: false,
});

// Copy plugin manifest
copyFileSync(
  resolve(rootDir, 'openclaw.plugin.json'),
  resolve(rootDir, 'dist/openclaw.plugin.json')
);

// Build the standalone CLI binary (used via `bin` field in package.json).
// esbuild hoists the input file's shebang to the top of the output
// automatically, so do NOT add a `banner` shebang here — it would produce
// a second shebang on line 2, which is a syntax error in ESM.
await esbuild.build({
  entryPoints: [resolve(rootDir, 'src/cli-bin.ts')],
  outfile: resolve(rootDir, 'dist/cli-bin.js'),
  format: 'esm',
  target: 'node18',
  platform: 'node',
  bundle: true,
  external: ['openclaw', 'openclaw/plugin-sdk', 'better-sqlite3'],
  sourcemap: false,
  minify: false,
});
// Make the binary executable.
const { chmodSync } = await import('node:fs');
chmodSync(resolve(rootDir, 'dist/cli-bin.js'), 0o755);

console.log('Build complete!');
