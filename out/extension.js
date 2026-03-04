"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const OLLAMA_ENDPOINT = 'http://localhost:11434/api';
const CHECK_INTERVAL = 10000;
let modelCache = new Map();
let isCheckingModels = false;
let modelChangeEmitter = new vscode.EventEmitter();
let knownModelIds = new Set();
function activate(context) {
    console.log('🚀 Ollama Agent Mode Enabler is activating...');
    // Register the Ollama language model provider
    const provider = vscode.lm.registerLanguageModelChatProvider('localollama', {
        onDidChangeLanguageModelChatInformation: modelChangeEmitter.event,
        async provideLanguageModelChatInformation() {
            try {
                return await getAvailableModels();
            }
            catch (error) {
                console.error('Error fetching Ollama models:', error);
                return [];
            }
        },
        async provideLanguageModelChatResponse(model, messages, options, progress, token) {
            return streamOllamaChat(model.id, messages, options, progress, token);
        },
        async provideTokenCount(model, text, _token) {
            if (typeof text === 'string') {
                return Math.ceil(text.length / 4);
            }
            return 0;
        }
    });
    context.subscriptions.push(provider);
    context.subscriptions.push(modelChangeEmitter);
    // Start periodic model checking
    startModelChecker(context);
    // Register command to manually refresh models
    context.subscriptions.push(vscode.commands.registerCommand('ollama-agentmode.refreshModels', async () => {
        modelCache.clear();
        const models = await getAvailableModels();
        knownModelIds = new Set(models.map(m => m.id));
        modelChangeEmitter.fire();
        vscode.window.showInformationMessage(`Ollama: Found ${models.length} model(s)`);
    }));
    vscode.window.showInformationMessage('✅ Ollama Agent Mode Enabler activated');
}
async function getAvailableModels() {
    try {
        const response = await fetch(`${OLLAMA_ENDPOINT}/tags`);
        if (!response.ok) {
            console.warn(`Ollama endpoint returned ${response.status}`);
            return [];
        }
        const data = (await response.json());
        const models = [];
        for (const model of data.models) {
            const modelInfo = {
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
                    agentMode: true // ✅ THIS IS THE KEY - Make models available in Agent mode
                },
                isUserSelectable: true
            };
            models.push(modelInfo);
            modelCache.set(model.model, modelInfo);
        }
        if (models.length > 0) {
            console.log(`📦 Ollama: Registered ${models.length} model(s) with Agent mode support`);
        }
        return models;
    }
    catch (error) {
        console.error('Failed to fetch Ollama models:', error);
        return [];
    }
}
function convertMessagesToOllama(messages) {
    const ollamaMessages = [];
    for (const msg of messages) {
        const isUser = msg.role === vscode.LanguageModelChatMessageRole.User;
        const defaultRole = isUser ? 'user' : 'assistant';
        if (typeof msg.content === 'string') {
            ollamaMessages.push({ role: defaultRole, content: msg.content });
            continue;
        }
        if (Array.isArray(msg.content)) {
            let textContent = '';
            const toolCalls = [];
            for (const part of msg.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    textContent += part.value;
                }
                else if (part instanceof vscode.LanguageModelToolCallPart) {
                    // Assistant is calling a tool
                    toolCalls.push({
                        function: {
                            name: part.name,
                            arguments: part.input
                        }
                    });
                }
                else if (part instanceof vscode.LanguageModelToolResultPart) {
                    // Tool result — becomes a 'tool' role message in Ollama
                    let resultContent = '';
                    if (Array.isArray(part.content)) {
                        for (const resultPart of part.content) {
                            if (resultPart instanceof vscode.LanguageModelTextPart) {
                                resultContent += resultPart.value;
                            }
                            else {
                                try {
                                    resultContent += JSON.stringify(resultPart);
                                }
                                catch {
                                    // ignore non-serializable tool result part
                                }
                            }
                        }
                    }
                    ollamaMessages.push({
                        role: 'tool',
                        content: resultContent,
                        tool_call_id: part.callId
                    });
                }
            }
            if (toolCalls.length > 0) {
                ollamaMessages.push({ role: 'assistant', content: textContent, tool_calls: toolCalls });
            }
            else if (textContent) {
                ollamaMessages.push({ role: defaultRole, content: textContent });
            }
        }
    }
    return ollamaMessages;
}
function convertToolsToOllama(tools) {
    return tools.map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema || { type: 'object', properties: {} }
        }
    }));
}
function parseToolArguments(raw) {
    if (raw && typeof raw === 'object') {
        return raw;
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
                return parsed;
            }
        }
        catch {
            console.warn('⚠️ Ollama returned non-JSON tool arguments string; using empty object');
        }
    }
    return {};
}
function parseXmlToolCalls(text) {
    // Fallback: detect XML-style tool invocations that some models emit in content
    // Pattern: <tool_name><param>value</param>...</tool_name>
    const toolCalls = [];
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
        const args = {};
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
async function streamOllamaChat(modelId, messages, options, progress, token) {
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
    const requestBody = {
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
        const systemMsg = {
            role: 'system',
            content: `You have access to tools: ${toolNames}.\nWhen you need to call a tool, you MUST use the JSON function-calling mechanism (tool_calls), NOT XML tags in your text. Do not write <tool_name>...</tool_name> in your response. Instead, return a structured tool call so it can be executed.`
        };
        if (requestBody.messages.length === 0 || requestBody.messages[0].role !== 'system') {
            requestBody.messages = [systemMsg, ...requestBody.messages];
        }
        else {
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
            if (!reader) {
                throw new Error('No response body');
            }
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                if (token.isCancellationRequested) {
                    reader.cancel();
                    break;
                }
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                for (let i = 0; i < lines.length - 1; i++) {
                    const line = lines[i].trim();
                    if (!line) {
                        continue;
                    }
                    try {
                        const chunk = JSON.parse(line);
                        if (chunk.message?.content) {
                            progress.report(new vscode.LanguageModelTextPart(chunk.message.content));
                        }
                    }
                    catch (e) { /* ignore parse errors */ }
                }
                buffer = lines[lines.length - 1];
            }
            if (buffer.trim()) {
                try {
                    const chunk = JSON.parse(buffer);
                    if (chunk.message?.content) {
                        progress.report(new vscode.LanguageModelTextPart(chunk.message.content));
                    }
                }
                catch (e) { /* ignore */ }
            }
        }
        else {
            // ── Non-streaming mode (tools present) ────────────────────────────
            // Read the entire response body as a single JSON object.
            const text = await response.text();
            let parsed;
            try {
                parsed = JSON.parse(text);
            }
            catch (e) {
                throw new Error(`Failed to parse Ollama response: ${text.slice(0, 200)}`);
            }
            const msg = parsed.message;
            if (!msg) {
                return;
            }
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
            }
            else {
                // Model chose not to call a tool — surface its text response
                console.warn('⚠️ Ollama: no tool_calls returned — model responded with text only');
                if (msg.content) {
                    progress.report(new vscode.LanguageModelTextPart(msg.content));
                }
            }
        }
    }
    catch (error) {
        console.error('Ollama chat error:', error);
        throw error;
    }
}
function startModelChecker(context) {
    const interval = setInterval(async () => {
        if (isCheckingModels)
            return;
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
        }
        finally {
            isCheckingModels = false;
        }
    }, CHECK_INTERVAL);
    context.subscriptions.push(new vscode.Disposable(() => clearInterval(interval)));
}
function formatModelName(name) {
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
function extractFamily(model) {
    // Extract family from model ID
    // e.g., "qwen:35b-a3b-q4_K_M" -> "qwen"
    return model.split(':')[0] || 'ollama';
}
function deactivate() {
    console.log('Ollama Agent Mode Enabler deactivated');
}
//# sourceMappingURL=extension.js.map