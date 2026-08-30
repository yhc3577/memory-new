#!/bin/bash
# Uninstall script for @yhc3577/memory-new
# Removes plugin from OpenClaw and cleans up configuration

set -e

echo "🧹 Cleaning up @yhc3577/memory-new..."

# 1. Uninstall npm package
echo "📦 Uninstalling npm package..."
npm uninstall @yhc3577/memory-new 2>/dev/null || true

# 2. Remove from OpenClaw plugins
echo "🔌 Removing from OpenClaw..."
openclaw plugins uninstall @yhc3577/memory-new 2>/dev/null || true

# 3. Clean up OpenClaw cached data
echo "🗑️  Cleaning cached data..."
rm -rf ~/.openclaw/npm/projects/yhc3577-memory-new-*

# 4. Clean up memory storage (optional - ask user)
echo ""
read -p "❓ Delete memory storage (~/.openclaw/memory-new)? This will delete all stored memories! [y/N] " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -rf ~/.openclaw/memory-new
    echo "✅ Memory storage deleted."
else
    echo "⏭️  Memory storage kept."
fi

echo ""
echo "✅ Uninstall complete!"
echo "📝 Note: Run 'openclaw gateway restart' to fully reload."
