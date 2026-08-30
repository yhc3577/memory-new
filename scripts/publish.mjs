#!/usr/bin/env node
/**
 * Publish script for @yhc3577/memory-new
 *
 * Usage:
 *   node scripts/publish.mjs [version]
 *
 * Examples:
 *   node scripts/publish.mjs          # Increments patch version (0.1.0 -> 0.1.1)
 *   node scripts/publish.mjs minor    # Increments minor version (0.1.0 -> 0.2.0)
 *   node scripts/publish.mjs major    # Increments major version (0.1.0 -> 1.0.0)
 *   node scripts/publish.mjs 1.2.3   # Sets specific version
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

function getPackageJson() {
  const pkgPath = join(rootDir, 'package.json');
  return JSON.parse(readFileSync(pkgPath, 'utf-8'));
}

function setPackageVersion(version) {
  const pkgPath = join(rootDir, 'package.json');
  const pkg = getPackageJson();
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`📝 Version set to: ${version}`);
}

function incrementVersion(type) {
  const pkg = getPackageJson();
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  
  let newVersion;
  switch (type) {
    case 'major':
      newVersion = `${major + 1}.0.0`;
      break;
    case 'minor':
      newVersion = `${major}.${minor + 1}.0`;
      break;
    case 'patch':
    default:
      newVersion = `${major}.${minor}.${patch + 1}`;
      break;
  }
  return newVersion;
}

function run(command, options = {}) {
  console.log(`\n🔧 Running: ${command}`);
  try {
    execSync(command, { cwd: rootDir, stdio: 'inherit', ...options });
    return true;
  } catch (e) {
    console.error(`❌ Command failed: ${command}`);
    return false;
  }
}

async function main() {
  const pkg = getPackageJson();
  const packageName = pkg.name;

  const args = process.argv.slice(2);
  const versionType = args[0]; // patch, minor, major, or specific version

  console.log(`🚀 ${packageName} Publishing Script\n`);
  console.log('='.repeat(50));

  // 1. Check if .npmrc exists with auth token
  const npmrcPath = join(rootDir, '.npmrc');
  const globalNpmrc = join(process.env.HOME || '/root', '.npmrc');
  
  let hasToken = false;
  if (existsSync(npmrcPath)) {
    hasToken = readFileSync(npmrcPath, 'utf-8').includes('_authToken');
  }
  if (!hasToken && existsSync(globalNpmrc)) {
    hasToken = readFileSync(globalNpmrc, 'utf-8').includes('_authToken');
  }
  
  if (!hasToken) {
    console.log('\n⚠️  No npm token found in .npmrc');
    console.log('   Please add your token:');
    console.log('   echo "//registry.npmjs.org/:_authToken=YOUR_TOKEN" >> ~/.npmrc');
    console.log('\n   Or create token at: https://www.npmjs.com/settings/-/tokens\n');
    process.exit(1);
  }

  // 2. Determine version
  let newVersion;
  if (versionType && /^\d+\.\d+\.\d+$/.test(versionType)) {
    newVersion = versionType;
  } else if (versionType) {
    newVersion = incrementVersion(versionType);
  } else {
    newVersion = incrementVersion('patch');
  }

  console.log(`\n📦 Current version: ${getPackageJson().version}`);
  setPackageVersion(newVersion);

  // 3. Install dependencies
  console.log('\n📦 Installing dependencies...');
  if (!run('pnpm install')) {
    process.exit(1);
  }

  // 4. Build
  console.log('\n📦 Building...');
  if (!run('pnpm run build')) {
    process.exit(1);
  }

  // 5. Publish
  console.log('\n📤 Publishing to npm...');
  if (!run('pnpm publish --access public --no-git-checks')) {
    process.exit(1);
  }

  console.log('\n' + '='.repeat(50));
  console.log(`✅ Successfully published ${packageName}@${newVersion}`);
  console.log(`   https://www.npmjs.com/package/${packageName}\n`);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
