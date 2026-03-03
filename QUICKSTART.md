# Ollama Agent Mode Enabler — Quick Start

## What This Does

Enables local Ollama models in VS Code Copilot Chat **Agent Mode** with full tool calling (file creation, editing, search, etc.).

**Verified working:** `qwen3.5:35b-a3b-q4_K_M` — file creation and multi-step agent tasks confirmed.

## Install (Any Machine)

### Prerequisites
- **VS Code** installed
- **Ollama** installed and running — `brew install ollama` or [ollama.com](https://ollama.com)
- A tool-capable model pulled, e.g. `ollama pull qwen3:8b`
- **git** available in terminal

### Steps

**1. Clone the repo**
```bash
git clone https://github.com/jeremycaris/ollama-agentmode.git
cd ollama-agentmode
```

**2. Install the extension**
Prerequisite: Node.js and npm must be installed (used to build/package the extension).
```bash
./install.sh
```

**3. Restart VS Code fully** (Cmd+Q then reopen)

**4. Start Ollama** (if not already running)
```bash
# Standard:
ollama serve

# With keep-alive to avoid cold-start delays:
OLLAMA_KEEP_ALIVE=-1 ollama serve
```

## Verify

1. Open Copilot Chat (Cmd+Shift+C)
2. Click the model selector → switch to **Agent mode**
3. Ollama models should appear in the picker
4. Ask it to create a file — it should call the tool and actually create it

## Requirements

- Ollama running at `http://localhost:11434`
- Model must support tool calling — check with `ollama show <model>` (look for `tools` in Capabilities)
- Recommended models: `qwen3`, `qwen3.5`, `llama3.1`, `mistral-nemo`

## How Tool Calling Works

```
User prompt
  → stream: false + tool_choice: required + tools: [...] to /api/chat
  → Ollama returns single JSON with tool_calls
  → LanguageModelToolCallPart reported to VS Code
  → VS Code executes the tool
  → LanguageModelToolResultPart sent back
  → Converted to Ollama { role: 'tool' } message
  → Next iteration → final response
```

**Key decisions:**
- `stream: false` when tools present — Ollama drops `tool_calls` when streaming
- `tool_choice: required` always — prevents model from choosing plain text over tool use
- System prompt injection — reinforces JSON format, suppresses XML-mode output
- XML fallback parser — catches `<tool_name>...</tool_name>` patterns as a safety net

## Troubleshooting

**Models not in Agent Mode picker:**
```bash
curl http://localhost:11434/api/tags   # confirm Ollama is running
# Cmd+Shift+P → Ollama: Refresh Models
```

**Model responds with text instead of calling tools:**
- Confirm model has tool support: `ollama show <model>` → must list `tools`
- Try `qwen3:8b` or `llama3.1` as a known-good baseline
- Open Help → Toggle Developer Tools → Console, look for `🔧 Ollama: forwarding N tool(s)`

**Extension not loading:**
```bash
code --list-extensions | grep ollama
# Help → Toggle Developer Tools → Console for errors
```

---

## Keeping Up-to-Date

When you make changes on one machine, sync to others:

```bash
# After making changes — commit and push:
git add -A && git commit -m "your message" && git push

# On any other machine — pull and reinstall:
git pull && ./install.sh
# Then restart VS Code
```

---

**Status:** ✅ Working — Agent Mode + Tool Calling confirmed
**No API keys required** — pure local execution
