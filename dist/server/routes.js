/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import { cliResultToOpenai, createDoneChunk, } from "../adapter/cli-to-openai.js";
import { sessionManager } from "../session/manager.js";
/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(req, res) {
    const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
    const body = req.body;
    const stream = body.stream === true;
    try {
        // Validate request
        if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
            res.status(400).json({
                error: {
                    message: "messages is required and must be a non-empty array",
                    type: "invalid_request_error",
                    code: "invalid_messages",
                },
            });
            return;
        }
        // Session management: track conversation → Claude session UUID mapping
        const conversationId = body.user || requestId;
        const sessionInfo = sessionManager.getOrCreate(conversationId, body.model || "sonnet");
        // Convert to CLI input format (always full history — --resume disabled due to CJK encoding bug)
        const cliInput = openaiToCli(body);
        cliInput.sessionId = sessionInfo.claudeSessionId;
        console.error(`[Routes] ${conversationId} -> ${sessionInfo.claudeSessionId} (msg #${sessionInfo.messageCount})`);
        const subprocess = new ClaudeSubprocess();
        if (stream) {
            await handleStreamingResponse(req, res, subprocess, cliInput, requestId);
        }
        else {
            await handleNonStreamingResponse(res, subprocess, cliInput, requestId);
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[handleChatCompletions] Error:", message);
        if (!res.headersSent) {
            res.status(500).json({
                error: {
                    message,
                    type: "server_error",
                    code: null,
                },
            });
        }
    }
}
/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(req, res, subprocess, cliInput, requestId) {
    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Request-Id", requestId);
    // CRITICAL: Flush headers immediately to establish SSE connection
    // Without this, headers are buffered and client times out waiting
    res.flushHeaders();
    // Send initial comment to confirm connection is alive
    res.write(":ok\n\n");
    return new Promise((resolve, reject) => {
        let isFirst = true;
        let lastModel = "claude-sonnet-4-6";
        let isComplete = false;
        let lastUsage = null;
        // Handle actual client disconnect (response stream closed)
        res.on("close", () => {
            if (!isComplete) {
                // Client disconnected before response completed - kill subprocess
                subprocess.kill();
            }
            resolve();
        });
        // Handle streaming content deltas
        subprocess.on("content_delta", (event) => {
            const text = event.event.delta?.text || "";
            if (text && !res.writableEnded) {
                const chunk = {
                    id: `chatcmpl-${requestId}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: lastModel,
                    choices: [{
                            index: 0,
                            delta: {
                                role: isFirst ? "assistant" : undefined,
                                content: text,
                            },
                            finish_reason: null,
                        }],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                isFirst = false;
            }
        });
        // Handle final assistant message (for model name and usage)
        subprocess.on("assistant", (message) => {
            lastModel = message.message.model;
            if (message.message.usage) {
                lastUsage = message.message.usage;
            }
        });
        subprocess.on("result", (result) => {
            isComplete = true;
            // Collect usage from result if available
            const usage = result.usage || lastUsage;
            if (!res.writableEnded) {
                // Send final done chunk with finish_reason and usage
                const doneChunk = createDoneChunk(requestId, lastModel, usage);
                res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
            }
            resolve();
        });
        subprocess.on("error", (error) => {
            console.error("[Streaming] Error:", error.message);
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({
                    error: { message: error.message, type: "server_error", code: null },
                })}\n\n`);
                res.end();
            }
            resolve();
        });
        subprocess.on("close", (code) => {
            // Subprocess exited - ensure response is closed
            if (!res.writableEnded) {
                if (code !== 0 && !isComplete) {
                    // Abnormal exit without result - send error
                    res.write(`data: ${JSON.stringify({
                        error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
                    })}\n\n`);
                }
                res.write("data: [DONE]\n\n");
                res.end();
            }
            resolve();
        });
        // Start the subprocess
        subprocess.start(cliInput.prompt, {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
            imageParts: cliInput.imageParts,
            continueSession: cliInput.continueSession,
            maxTokens: cliInput.maxTokens,
        }).catch((err) => {
            console.error("[Streaming] Subprocess start error:", err);
            reject(err);
        });
    });
}
/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(res, subprocess, cliInput, requestId) {
    return new Promise((resolve) => {
        let finalResult = null;
        subprocess.on("result", (result) => {
            finalResult = result;
        });
        subprocess.on("error", (error) => {
            console.error("[NonStreaming] Error:", error.message);
            res.status(500).json({
                error: {
                    message: error.message,
                    type: "server_error",
                    code: null,
                },
            });
            resolve();
        });
        subprocess.on("close", (code) => {
            if (finalResult) {
                res.json(cliResultToOpenai(finalResult, requestId));
            }
            else if (!res.headersSent) {
                res.status(500).json({
                    error: {
                        message: `Claude CLI exited with code ${code} without response`,
                        type: "server_error",
                        code: null,
                    },
                });
            }
            resolve();
        });
        // Start the subprocess
        subprocess
            .start(cliInput.prompt, {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
            imageParts: cliInput.imageParts,
            continueSession: cliInput.continueSession,
            maxTokens: cliInput.maxTokens,
        })
            .catch((error) => {
            res.status(500).json({
                error: {
                    message: error.message,
                    type: "server_error",
                    code: null,
                },
            });
            resolve();
        });
    });
}
/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req, res) {
    const ts = Math.floor(Date.now() / 1000);
    res.json({
        object: "list",
        data: [
            { id: "claude-opus-4-6", object: "model", owned_by: "anthropic", created: ts },
            { id: "claude-sonnet-4-6", object: "model", owned_by: "anthropic", created: ts },
            { id: "claude-opus-4-5", object: "model", owned_by: "anthropic", created: ts },
            { id: "claude-sonnet-4-5", object: "model", owned_by: "anthropic", created: ts },
            { id: "claude-haiku-4-5", object: "model", owned_by: "anthropic", created: ts },
        ],
    });
}
/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req, res) {
    res.json({
        status: "ok",
        provider: "claude-code-cli",
        timestamp: new Date().toISOString(),
    });
}
//# sourceMappingURL=routes.js.map