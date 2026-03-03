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
                finish_reason: message.message.stop_reason ? "stop" : null,
            },
        ],
    };
}
/**
 * Create a final "done" chunk for streaming
 */
export function createDoneChunk(requestId, model) {
    return {
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
                finish_reason: "stop",
            },
        ],
        usage: {
            prompt_tokens: result.usage?.input_tokens || 0,
            completion_tokens: result.usage?.output_tokens || 0,
            total_tokens: (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
        },
    };
}
/**
 * Normalize Claude model names to a consistent format
 * e.g., "claude-sonnet-4-5-20250929" -> "claude-sonnet-4"
 */
function normalizeModelName(model) {
    if (!model) return "claude-sonnet-4-6";
    if (model.includes("opus"))
        return "claude-opus-4";
    if (model.includes("sonnet"))
        return "claude-sonnet-4";
    if (model.includes("haiku"))
        return "claude-haiku-4";
    return model;
}
//# sourceMappingURL=cli-to-openai.js.map