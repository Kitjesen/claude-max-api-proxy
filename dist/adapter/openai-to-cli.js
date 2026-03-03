/**
 * Converts OpenAI chat request format to Claude CLI input
 */
const MODEL_MAP = {
    // Direct model names (legacy aliases)
    "claude-opus-4": "claude-opus-4-5",
    "claude-sonnet-4": "claude-sonnet-4-5",
    "claude-haiku-4": "claude-haiku-4-5",
    // Current versioned model IDs — pass through directly
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "claude-opus-4-6": "claude-opus-4-6",
    "claude-sonnet-4-5": "claude-sonnet-4-5",
    "claude-opus-4-5": "claude-opus-4-5",
    "claude-haiku-4-5": "claude-haiku-4-5",
    // With provider prefix (maxproxy/...)
    "maxproxy/claude-sonnet-4-6": "claude-sonnet-4-6",
    "maxproxy/claude-opus-4-6": "claude-opus-4-6",
    // With old provider prefix
    "claude-code-cli/claude-opus-4": "claude-opus-4-5",
    "claude-code-cli/claude-sonnet-4": "claude-sonnet-4-5",
    "claude-code-cli/claude-haiku-4": "claude-haiku-4-5",
    // Short aliases
    "opus": "claude-opus-4-6",
    "sonnet": "claude-sonnet-4-6",
    "haiku": "claude-haiku-4-5",
};
/**
 * Extract Claude model alias from request model string
 */
export function extractModel(model) {
    // Try direct lookup
    if (MODEL_MAP[model]) {
        return MODEL_MAP[model];
    }
    // Try stripping provider prefix
    const stripped = model.replace(/^claude-code-cli\//, "");
    if (MODEL_MAP[stripped]) {
        return MODEL_MAP[stripped];
    }
    // Pass through as-is if it looks like a valid claude model ID, else default to sonnet
    if (model && model.startsWith("claude-")) {
        return model;
    }
    return "claude-sonnet-4-6";
}
/**
 * Extract plain text from a message content field.
 * OpenAI content can be a string OR an array of content parts.
 */
function extractText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter((part) => part.type === "text")
            .map((part) => part.text || "")
            .join("");
    }
    return content != null ? String(content) : "";
}
/**
 * Extract image content parts from all messages.
 * Returns Claude API image objects ready for stream-json input format.
 * Handles both base64 data URLs and HTTP(S) URLs.
 */
function extractImageParts(messages) {
    const parts = [];
    for (const msg of messages) {
        if (!Array.isArray(msg.content)) continue;
        for (const part of msg.content) {
            if (part.type !== "image_url") continue;
            const url = part.image_url?.url || part.url;
            if (!url) continue;
            if (url.startsWith("data:")) {
                // base64 data URL: data:image/jpeg;base64,...
                const m = url.match(/^data:([^;]+);base64,(.+)$/);
                if (m) {
                    parts.push({
                        type: "image",
                        source: { type: "base64", media_type: m[1], data: m[2] },
                    });
                }
            } else {
                // HTTP/HTTPS URL — pass through directly
                parts.push({
                    type: "image",
                    source: { type: "url", url },
                });
            }
        }
    }
    return parts;
}
/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * We format the messages into a readable format that preserves context.
 */
export function messagesToPrompt(messages) {
    const parts = [];
    for (const msg of messages) {
        const text = extractText(msg.content);
        switch (msg.role) {
            case "system":
                parts.push(`<system>\n${text}\n</system>\n`);
                break;
            case "user":
                parts.push(text);
                break;
            case "assistant":
                parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
                break;
        }
    }
    return parts.join("\n").trim();
}
/**
 * Extract only the last user message text (for session continuation).
 * When continuing a session, we only send the new message — previous context
 * is already in the Claude CLI session.
 */
function extractLastUserMessage(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
            return extractText(messages[i].content);
        }
    }
    return "";
}
/**
 * Extract image parts from only the last user message (for session continuation).
 */
function extractLastUserImageParts(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
            return extractImageParts([messages[i]]);
        }
    }
    return [];
}
/**
 * Convert OpenAI chat request to CLI input format.
 * When continueSession=true, only the last user message is extracted
 * (previous context is preserved in Claude CLI session).
 */
export function openaiToCli(request, continueSession = false) {
    return {
        prompt: continueSession
            ? extractLastUserMessage(request.messages)
            : messagesToPrompt(request.messages),
        model: extractModel(request.model),
        sessionId: request.user, // Use OpenAI's user field for session mapping
        imageParts: continueSession
            ? extractLastUserImageParts(request.messages)
            : extractImageParts(request.messages), // Claude API image content parts
        continueSession,
        maxTokens: request.max_tokens || request.max_completion_tokens || undefined,
    };
}
//# sourceMappingURL=openai-to-cli.js.map