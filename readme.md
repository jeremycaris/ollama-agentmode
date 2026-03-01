# Ollama Agent Mode Enabler

🤖 VS Code extension that enables **Agent Mode** support for local Ollama models in Copilot Chat, with full tool calling.

## What This Extension Fixes

VS Code's built-in Ollama integration has several gaps that prevent local models from working in Agent Mode:

| Problem | Root Cause | Fix |
|---|---|---|
| Models missing from Agent Mode picker | Built-in provider omits `agentMode: true` capability flag | Registers models with both `agentMode: true` and `toolCalling: true` |
| Tools never reach the model | `options.tools` was never forwarded to Ollama's API | Converts VS Code tool definitions to Ollama format and includes them in every request |
| `tool_calls` silently dropped | Ollama doesn't reliably emit `tool_calls` when `stream: true` | Switches to `stream: false` whenever tools are present |
| Model responds with text instead of calling tools | With `tool_choice: auto`, models in multi-turn agent context often choose plain text | Always sends `tool_choice: required` when tools are available |
| XML tool invocations in content ignored | Some models emit `<tool_name>...</tool_name>` markup in text rather than JSON `tool_calls` | XML fallback parser detects and converts these to real tool call events |

## How Tool Calling Works

```
User prompt
  → VS Code sends messages + tool definitions to extension
  → stream: false + tool_choice: required + tools: [...] sent to /api/chat
  → Ollama returns single JSON with tool_calls
  → LanguageModelToolCallPart reported to VS Code
  → VS Code executes the tool (creates file, reads file, etc.)
  → LanguageModelToolResultPart sent back to extension
  → Converted to Ollama { role: 'tool' } message
  → Next iteration → final response
```

## Current Status

| Capability | Status |
|---|---|
| Models appear in Agent Mode | ✅ Working |
| Text chat (Ask / Edit modes) | ✅ Streaming |
| Tool definitions forwarded to Ollama | ✅ Working |
| Tool call responses parsed & reported | ✅ Working |
| Tool results sent back to model | ✅ Working |
| XML-style tool invocation fallback | ✅ Working |

> **Verified working:** `qwen3.5:35b-a3b-q4_K_M` — file creation, editing, and multi-step agent tasks confirmed.

## Requirements

- **Ollama running** at `http://localhost:11434`
- **Model must support tool calling** natively — check with `ollama show <model>` and look for `tools` in the Capabilities section
- **Recommended models:** `qwen3`, `qwen3.5`, `llama3.1`, `mistral-nemo`
- **Keep-alive recommended** to avoid cold-start latency:
  ```bash
  OLLAMA_KEEP_ALIVE=-1 ollama serve
  ```

## Installation

```bash
code --install-extension /path/to/ollama-agentmode-enabler --force
```

Then **restart VS Code** completely (Cmd+Q and reopen).

## Verification

1. Open Copilot Chat (Cmd+Shift+C)
2. Click the model selector → switch to **Agent mode**
3. Your Ollama models should appear in the picker
4. Ask it to create a file — it should call the tool and actually create it

## Troubleshooting

### Models not showing in Agent Mode
1. Verify Ollama is reachable: `curl http://localhost:11434/api/tags`
2. Restart VS Code fully
3. Cmd+Shift+P → **Ollama: Refresh Models**

### Model shows up but does nothing / gives a text response
- Confirm tool support: `ollama show <model>` — must list `tools` in Capabilities
- Not all models support tool calling — switch to `qwen3:8b` or `llama3.1` to confirm
- Open **Help → Toggle Developer Tools** and look for `🔧 Ollama: forwarding N tool(s)` — if absent, tools aren't being passed

### Extension not loading
```bash
code --list-extensions | grep ollama
# Help → Toggle Developer Tools → Console for errors
```

## Technical Details

- Registers models via `vscode.lm.registerLanguageModelChatProvider` with `agentMode: true`
- Uses `stream: false` + `tool_choice: required` when tools are present
- Uses NDJSON streaming for plain chat (no tools) — Ask / Edit modes
- Injects a system prompt reinforcing JSON `tool_calls` format to prevent XML-mode output
- XML fallback parser catches `<tool_name><param>value</param></tool_name>` patterns in model content
- Converts `LanguageModelToolResultPart` → Ollama `{ role: 'tool', content, tool_call_id }` messages
- Falls back to `vscode.lm.tools` if `toolMode: Required` arrives with empty `options.tools`
- Does not modify any VS Code settings

## Uninstall

```bash
code --uninstall-extension local-dev.ollama-agentmode-enabler
```
