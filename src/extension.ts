import * as vscode from 'vscode';

interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: any;
}

interface OllamaListResponse {
  models: OllamaModel[];
}

interface OllamaToolFunction {
  name: string;
  arguments: unknown;
}

interface OllamaToolCall {
  id?: string;
  function: OllamaToolFunction;
}

interface OllamaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters?: any;
  };
}

interface OllamaChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: boolean;
  tools?: OllamaToolDefinition[];
  tool_choice?: 'auto' | 'required';
}

interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: OllamaChatMessage;
  done: boolean;
  done_reason?: string;
}

const OLLAMA_ENDPOINT = 'http://localhost:11434/api';
const CHECK_INTERVAL = 10000;

let modelCache: Map<string, any> = new Map();
let isCheckingModels = false;
let modelChangeEmitter: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
let knownModelIds: Set<string> = new Set();

export function activate(context: vscode.ExtensionContext) {
  console.log('🚀 Ollama Agent Mode Enabler is activating...');

  // Register the Ollama language model provider
  const provider = vscode.lm.registerLanguageModelChatProvider('localollama', {
    onDidChangeLanguageModelChatInformation: modelChangeEmitter.event,

    async provideLanguageModelChatInformation() {
      try {
        return await getAvailableModels();
      } catch (error) {
        console.error('Error fetching Ollama models:', error);
        return [];
      }
    },

    async provideLanguageModelChatResponse(
      model: vscode.LanguageModelChatInformation,
      messages: readonly vscode.LanguageModelChatRequestMessage[],
      options: vscode.ProvideLanguageModelChatResponseOptions,
      progress: vscode.Progress<vscode.LanguageModelResponsePart>,
      token: vscode.CancellationToken
    ) {
      return streamOllamaChat(model.id, messages, options, progress, token);
    },

    async provideTokenCount(model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken) {
      if (typeof text === 'string') {
        return Math.ceil(text.length / 4);
      }
      return 0;
    }
  }) as any;

  context.subscriptions.push(provider);
  context.subscriptions.push(modelChangeEmitter);

  // Start periodic model checking
  startModelChecker(context);

  // Register command to manually refresh models
  context.subscriptions.push(
    vscode.commands.registerCommand('ollama-agentmode.refreshModels', async () => {
      modelCache.clear();
      const models = await getAvailableModels();
      knownModelIds = new Set(models.map(m => m.id));
      modelChangeEmitter.fire();
      vscode.window.showInformationMessage(`Ollama: Found ${models.length} model(s)`);
    })
  );

  vscode.window.showInformationMessage('✅ Ollama Agent Mode Enabler activated');
}

async function getAvailableModels(): Promise<vscode.LanguageModelChatInformation[]> {
  try {
    const response = await fetch(`${OLLAMA_ENDPOINT}/tags`);
    
    if (!response.ok) {
      console.warn(`Ollama endpoint returned ${response.status}`);
      return [];
    }

    const data = (await response.json()) as OllamaListResponse;
    const models: vscode.LanguageModelChatInformation[] = [];

    for (const model of data.models) {
      const modelInfo: any = {
        id: model.model,
        name: formatModelName(model.name),
        vendor: 'localollama',
        version: '1.0.0',
        family: extractFamily(model.model),
        maxInputTokens: 128000,
        maxOutputTokens: 8192,
        // Use 'any' to bypass strict type checking for the agentMode flag
        capabilities: {
          toolCalling: true,
          agentMode: true  // ✅ THIS IS THE KEY - Make models available in Agent mode
        } as any,
        isUserSelectable: true
      };

      models.push(modelInfo);
      modelCache.set(model.model, modelInfo);
    }

    if (models.length > 0) {
      console.log(`📦 Ollama: Registered ${models.length} model(s) with Agent mode support`);
    }

    return models;
  } catch (error) {
    console.error('Failed to fetch Ollama models:', error);
    return [];
  }
}

function convertMessagesToOllama(messages: readonly vscode.LanguageModelChatRequestMessage[]): OllamaChatMessage[] {
  const ollamaMessages: OllamaChatMessage[] = [];

  for (const msg of messages) {
    const isUser = msg.role === vscode.LanguageModelChatMessageRole.User;
    const defaultRole = isUser ? 'user' : 'assistant';

    if (typeof msg.content === 'string') {
      ollamaMessages.push({ role: defaultRole, content: msg.content });
      continue;
    }

    if (Array.isArray(msg.content)) {
      let textContent = '';
      const toolCalls: OllamaToolCall[] = [];

      for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textContent += part.value;
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          // Assistant is calling a tool
          toolCalls.push({
            function: {
              name: part.name,
              arguments: part.input as Record<string, any>
            }
          });
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          // Tool result — becomes a 'tool' role message in Ollama
          let resultContent = '';
          if (Array.isArray((part as any).content)) {
            for (const resultPart of (part as any).content) {
              if (resultPart instanceof vscode.LanguageModelTextPart) {
                resultContent += resultPart.value;
              } else {
                try {
                  resultContent += JSON.stringify(resultPart);
                } catch {
                  // ignore non-serializable tool result part
                }
              }
            }
          }
          ollamaMessages.push({
            role: 'tool',
            content: resultContent,
            tool_call_id: (part as any).callId
          });
        }
      }

      if (toolCalls.length > 0) {
        ollamaMessages.push({ role: 'assistant', content: textContent, tool_calls: toolCalls });
      } else if (textContent) {
        ollamaMessages.push({ role: defaultRole, content: textContent });
      }
    }
  }

  return ollamaMessages;
}

function convertToolsToOllama(tools: readonly vscode.LanguageModelChatTool[]): OllamaToolDefinition[] {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: (tool as any).inputSchema || { type: 'object', properties: {} }
    }
  }));
}

function parseToolArguments(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object') {
    return raw as Record<string, any>;
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const unfenced = trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    try {
      const parsed = JSON.parse(unfenced);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, any>;
      }
    } catch {
      console.warn('⚠️ Ollama returned non-JSON tool arguments string; using empty object');
    }
  }

  return {};
}

function parseXmlToolCalls(text: string): OllamaToolCall[] | null {
  // Fallback: detect XML-style tool invocations that some models emit in content
  // Pattern: <tool_name><param>value</param>...</tool_name>
  const toolCalls: OllamaToolCall[] = [];
  const toolPattern = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let match;
  while ((match = toolPattern.exec(text)) !== null) {
    const toolName = match[1];
    const body = match[2];
    // Skip obvious non-tool tags
    if (['p', 'b', 'i', 'em', 'strong', 'code', 'pre', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'table', 'tr', 'td', 'th'].includes(toolName)) {
      continue;
    }
    // Parse child elements as arguments
    const args: Record<string, string> = {};
    const argPattern = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let argMatch;
    while ((argMatch = argPattern.exec(body)) !== null) {
      args[argMatch[1]] = argMatch[2].trim();
    }
    if (Object.keys(args).length > 0) {
      toolCalls.push({ function: { name: toolName, arguments: args } });
    }
  }
  return toolCalls.length > 0 ? toolCalls : null;
}

async function streamOllamaChat(
  modelId: string,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken
): Promise<void> {
  const ollamaMessages = convertMessagesToOllama(messages);
  const optionTools = options.tools ?? [];
  const fallbackTools = options.toolMode === vscode.LanguageModelChatToolMode.Required && optionTools.length === 0
    ? vscode.lm.tools
    : [];
  const runtimeTools = optionTools.length > 0 ? optionTools : fallbackTools;
  const hasTools = runtimeTools.length > 0;

  if (optionTools.length === 0 && fallbackTools.length > 0) {
    console.warn(`⚠️ Ollama: options.tools was empty in Required mode; falling back to vscode.lm.tools (${fallbackTools.length})`);
  }

  // Ollama does not reliably stream tool_calls — when tools are present
  // we use stream:false so the full response (including tool_calls) is
  // returned as a single JSON object.
  const requestBody: OllamaChatRequest = {
    model: modelId,
    messages: ollamaMessages,
    stream: !hasTools
  };

  if (hasTools) {
    requestBody.tools = convertToolsToOllama(runtimeTools);
    // Always use 'required' when tools are present — with 'auto', Qwen3.5 may
    // respond with plain text in a multi-turn agent-mode conversation context.
    requestBody.tool_choice = 'required';
    // Prepend a system message so the model uses JSON tool_calls, not XML text
    const toolNames = runtimeTools.map(t => t.name).join(', ');
    const systemMsg: OllamaChatMessage = {
      role: 'system',
      content: `You have access to tools: ${toolNames}.\nWhen you need to call a tool, you MUST use the JSON function-calling mechanism (tool_calls), NOT XML tags in your text. Do not write <tool_name>...</tool_name> in your response. Instead, return a structured tool call so it can be executed.`
    };
    if (requestBody.messages.length === 0 || requestBody.messages[0].role !== 'system') {
      requestBody.messages = [systemMsg, ...requestBody.messages];
    } else {
      // Append to existing system message
      requestBody.messages[0] = {
        ...requestBody.messages[0],
        content: requestBody.messages[0].content + '\n' + systemMsg.content
      };
    }
    console.log(`🔧 Ollama: forwarding ${runtimeTools.length} tool(s) to model (non-streaming, mode=${requestBody.tool_choice})`);
  }

  try {
    const response = await fetch(`${OLLAMA_ENDPOINT}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.statusText}`);
    }

    if (!hasTools) {
      // ── Streaming mode (no tools) ──────────────────────────────────────
      const reader = response.body?.getReader();
      if (!reader) { throw new Error('No response body'); }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        if (token.isCancellationRequested) { reader.cancel(); break; }

        const { done, value } = await reader.read();
        if (done) { break; }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');

        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (!line) { continue; }
          try {
            const chunk = JSON.parse(line) as OllamaChatResponse;
            if (chunk.message?.content) {
              progress.report(new vscode.LanguageModelTextPart(chunk.message.content));
            }
          } catch (e) { /* ignore parse errors */ }
        }

        buffer = lines[lines.length - 1];
      }

      if (buffer.trim()) {
        try {
          const chunk = JSON.parse(buffer) as OllamaChatResponse;
          if (chunk.message?.content) {
            progress.report(new vscode.LanguageModelTextPart(chunk.message.content));
          }
        } catch (e) { /* ignore */ }
      }
    } else {
      // ── Non-streaming mode (tools present) ────────────────────────────
      // Read the entire response body as a single JSON object.
      const text = await response.text();
      let parsed: OllamaChatResponse;
      try {
        parsed = JSON.parse(text) as OllamaChatResponse;
      } catch (e) {
        throw new Error(`Failed to parse Ollama response: ${text.slice(0, 200)}`);
      }

      const msg = parsed.message;
      if (!msg) { return; }

      // Prefer JSON tool_calls; fall back to XML-style tool invocations found in content
      const toolCallsToReport = (msg.tool_calls && msg.tool_calls.length > 0)
        ? msg.tool_calls
        : (msg.content ? parseXmlToolCalls(msg.content) : null);

      if (toolCallsToReport && toolCallsToReport.length > 0) {
        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          console.warn(`⚠️ Ollama: XML tool invocation in content; parsed ${toolCallsToReport.length} call(s) as fallback`);
        }
        for (const toolCall of toolCallsToReport) {
          const callId = toolCall.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const args = parseToolArguments(toolCall.function.arguments);
          console.log(`🔧 Ollama tool call: ${toolCall.function.name}`, args);
          progress.report(new vscode.LanguageModelToolCallPart(callId, toolCall.function.name, args));
        }
      } else {
        // Model chose not to call a tool — surface its text response
        console.warn('⚠️ Ollama: no tool_calls returned — model responded with text only');
        if (msg.content) {
          progress.report(new vscode.LanguageModelTextPart(msg.content));
        }
      }
    }
  } catch (error) {
    console.error('Ollama chat error:', error);
    throw error;
  }
}

function startModelChecker(context: vscode.ExtensionContext): void {
  const interval = setInterval(async () => {
    if (isCheckingModels) return;
    
    isCheckingModels = true;
    try {
      // Periodically refresh models and detect changes
      const freshModels = await getAvailableModels();
      const freshIds = new Set(freshModels.map(m => m.id));
      const changed = freshIds.size !== knownModelIds.size || 
        [...freshIds].some(id => !knownModelIds.has(id)) ||
        [...knownModelIds].some(id => !freshIds.has(id));
      
      if (changed) {
        knownModelIds = freshIds;
        modelChangeEmitter.fire();
        console.log('🔔 Ollama: model list changed, notified VS Code');
      }
    } finally {
      isCheckingModels = false;
    }
  }, CHECK_INTERVAL);

  context.subscriptions.push(
    new vscode.Disposable(() => clearInterval(interval))
  );
}

function formatModelName(name: string): string {
  // Format: "family:tag" -> "Family Tag"
  // e.g., "qwen:35b-a3b-q4_K_M" -> "Qwen (35b)"
  const parts = name.split(':');
  const family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  
  if (parts[1]) {
    // Extract size from tag like "35b-a3b-q4_K_M"
    const sizeMatch = parts[1].match(/^(\d+[a-z]?)/);
    const size = sizeMatch ? sizeMatch[1] : parts[1];
    return `${family} (${size})`;
  }
  
  return family;
}

function extractFamily(model: string): string {
  // Extract family from model ID
  // e.g., "qwen:35b-a3b-q4_K_M" -> "qwen"
  return model.split(':')[0] || 'ollama';
}

export function deactivate() {
  console.log('Ollama Agent Mode Enabler deactivated');
}
