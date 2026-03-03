#!/usr/bin/env bash
# Install Ollama Agent Mode Enabler extension

set -euo pipefail

echo "🚀 Installing Ollama Agent Mode Enabler..."
echo "==========================================="

# Resolve to the directory this script lives in (works from any cwd)
EXTENSION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$EXTENSION_DIR/out/extension.js" ]; then
  echo "❗ out/extension.js not found. Building extension..."
  if ! command -v npm >/dev/null 2>&1; then
    echo "❌ npm not found. Install Node.js/npm and run 'npm install' then retry."
    exit 1
  fi
  (cd "$EXTENSION_DIR" && npm install)
  (cd "$EXTENSION_DIR" && npm run compile)
  if [ ! -f "$EXTENSION_DIR/out/extension.js" ]; then
    echo "❌ Build failed — out/extension.js still missing. Aborting."
    exit 1
  fi
fi

# Package the extension into a .vsix and install
echo ""
echo "📦 Packaging extension as .vsix..."
if ! command -v code >/dev/null 2>&1; then
  echo "❌ 'code' CLI not found. Install 'code' command from VS Code: Cmd+Shift+P → 'Shell Command: Install 'code' command in PATH'"
  exit 1
fi

VSIX_PATH="$EXTENSION_DIR/$(basename "$EXTENSION_DIR").vsix"

if command -v npx >/dev/null 2>&1; then
  # Ensure dev deps (like typescript) are installed so prepublish scripts can run
  if [ ! -x "$EXTENSION_DIR/node_modules/.bin/tsc" ]; then
    echo "🔧 Installing devDependencies so build tools are available..."
    (cd "$EXTENSION_DIR" && npm install)
  fi
  (cd "$EXTENSION_DIR" && npx --yes @vscode/vsce@latest package --out "$VSIX_PATH" --allow-missing-repository) || {
    echo "⚠️  Packaging with 'vsce' failed. You can install 'vsce' and run 'vsce package' in the extension dir.";
  }
else
  echo "⚠️  'npx' not found — cannot automatically package. Please run 'npx @vscode/vsce package' in $EXTENSION_DIR and then rerun this script."
fi

if [ ! -f "$VSIX_PATH" ]; then
  echo "❌ .vsix not found. Aborting installation."
  exit 1
fi

echo ""
echo "📦 Installing extension in VS Code..."
code --install-extension "$VSIX_PATH" --force

# Clean up the generated .vsix
rm -f "$VSIX_PATH"

echo ""
echo "✅ Extension installed!"
echo ""
echo "📋 Next steps:"
echo "   1. Close VS Code completely (Cmd+Q)"
echo "   2. Wait 2 seconds"
echo "   3. Reopen VS Code"
echo "   4. Open Copilot Chat (Cmd+Shift+C)"
echo "   5. Click the model selector and switch to Agent mode"
echo "   6. Your Ollama models should now appear!"
echo ""
echo "💡 Tip: If models don't show, run this command in VS Code:"
echo "   Cmd+Shift+P → 'Ollama: Refresh Models'"
