/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */
/**
 * Extract text content from Claude CLI assistant message
 */
export function extractTextContent(message) {
    return message.message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
}
/**
 * Convert Claude CLI assistant message to OpenAI streaming chunk
 */
export function cliToOpenaiChunk(message, requestId, isFirst = false) {
    const text = extractTextContent(message);
    return {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: normalizeModelName(message.message.model),
        choices: [
            {
                index: 0,
                delta: {
                    role: isFirst ? "assistant" : undefined,
                    content: text,
                },
                finish_reason: mapStopReason(message.message.stop_reason),
            },
        ],
    };
}
/**
 * Create a final "done" chunk for streaming, with optional usage
 */
export function createDoneChunk(requestId, model, usage) {
    const chunk = {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: normalizeModelName(model),
        choices: [
            {
                index: 0,
                delta: {},
                finish_reason: "stop",
            },
        ],
    };
    if (usage) {
        chunk.usage = {
            prompt_tokens: usage.input_tokens || 0,
            completion_tokens: usage.output_tokens || 0,
            total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
            cache_read_input_tokens: usage.cache_read_input_tokens || 0,
            cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
        };
    }
    return chunk;
}
/**
 * Convert Claude CLI result to OpenAI non-streaming response
 */
export function cliResultToOpenai(result, requestId) {
    // Get model from modelUsage, direct model field, or default.
    // modelUsage may be {} (empty) in stream-json input mode.
    const usageKeys = result.modelUsage ? Object.keys(result.modelUsage) : [];
    const modelName = (usageKeys.length > 0 ? usageKeys[0] : null)
        || result.model
        || "claude-sonnet-4-6";
    const stopReason = mapStopReason(result.stopReason || "end_turn");
    return {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: normalizeModelName(modelName),
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content: result.result,
                },
                finish_reason: stopReason,
            },
        ],
        usage: {
            prompt_tokens: result.usage?.input_tokens || 0,
            completion_tokens: result.usage?.output_tokens || 0,
            total_tokens: (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
            cache_read_input_tokens: result.usage?.cache_read_input_tokens || 0,
            cache_creation_input_tokens: result.usage?.cache_creation_input_tokens || 0,
        },
    };
}
/**
 * Map Claude stop reason to OpenAI finish_reason
 */
function mapStopReason(reason) {
    if (!reason) return null;
    switch (reason) {
        case "end_turn":
        case "stop":
        case "stop_sequence":
            return "stop";
        case "max_tokens":
            return "length";
        case "tool_use":
            return "tool_calls";
        default:
            return "stop";
    }
}
/**
 * Normalize Claude model names — preserve full version IDs
 */
function normalizeModelName(model) {
    if (!model) return "claude-sonnet-4-6";
    // Strip date suffixes like -20250929
    return model.replace(/-\d{8}$/, "");
}
//# sourceMappingURL=cli-to-openai.js.map
