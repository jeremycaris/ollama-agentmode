#!/bin/bash
# Install Ollama Agent Mode Enabler extension

set -e

echo "🚀 Installing Ollama Agent Mode Enabler..."
echo "==========================================="

# Resolve to the directory this script lives in (works from any cwd)
EXTENSION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$EXTENSION_DIR/out/extension.js" ]; then
  echo "❌ out/extension.js not found. Run 'npm run compile' first."
  exit 1
fi

# Install the extension
echo ""
echo "📦 Installing extension in VS Code..."
code --install-extension "$EXTENSION_DIR" --force

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
