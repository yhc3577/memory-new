#!/usr/bin/env node
/**
 * Pre-uninstall script - runs before npm uninstall
 * Cleans up OpenClaw configuration for memory_new
 */

import { execSync } from 'child_process';
import { rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

function run(cmd) {
  console.log(`🔧 Running: ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit' });
    return true;
  } catch (e) {
    console.log(`⚠️  Command failed (non-fatal): ${cmd}`);
    return false;
  }
}

console.log('🧹 Pre-uninstall cleanup for @yhc3577/memory-new...\n');

// 1. Remove from OpenClaw plugins
run('openclaw plugins uninstall @yhc3577/memory-new 2>/dev/null || true');

// 2. Clean up cached npm projects
const npmDir = join(process.env.HOME || '/root', '.openclaw/npm/projects');
const prefixes = ['yhc3577-memory-new-'];

try {
  if (existsSync(npmDir)) {
    const { readdirSync, statSync } = await import('fs');
    const entries = readdirSync(npmDir);
    for (const entry of entries) {
      if (prefixes.some(p => entry.startsWith(p))) {
        const fullPath = join(npmDir, entry);
        console.log(`🗑️  Removing cached project: ${entry}`);
        rmSync(fullPath, { recursive: true, force: true });
      }
    }
  }
} catch (e) {
  console.log(`⚠️  Could not clean npm cache: ${e.message}`);
}

console.log('\n✅ Pre-uninstall cleanup complete!');
console.log('📝 Note: Memory storage (~/.openclaw/memory-new) was NOT deleted.');
console.log('   If you want to delete all memories, run: rm -rf ~/.openclaw/memory-new\n');
