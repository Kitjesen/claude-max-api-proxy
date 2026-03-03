/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 *
 * Windows optimizations:
 * - Direct node.exe spawn (bypasses cmd.exe, faster startup)
 * - stream-json input format (safer Unicode handling)
 * - SIGKILL + taskkill fallback for zombie processes
 * - Session persistence enabled (sessions saved to disk)
 *
 * NOTE: --resume is disabled due to Claude CLI CJK encoding bug on Windows
 * (session JSONL files store Chinese text with system codepage instead of UTF-8).
 * Enable "Beta: Use Unicode UTF-8 for worldwide language support" in Windows
 * Region Settings to fix this, then re-enable --resume in buildArgs().
 */
import { spawn } from "child_process";
import { EventEmitter } from "events";
import { isAssistantMessage, isResultMessage, isContentDelta } from "../types/claude-cli.js";
const DEFAULT_TIMEOUT = 600000; // 10 minutes (match OpenClaw timeoutSeconds)
export class ClaudeSubprocess extends EventEmitter {
    process = null;
    buffer = "";
    timeoutId = null;
    isKilled = false;
    /**
     * Start the Claude CLI subprocess with the given prompt
     */
    async start(prompt, options) {
        const hasImages = Array.isArray(options.imageParts) && options.imageParts.length > 0;
        // Only use stream-json input for images (plain text works better for CJK on Windows)
        const useStreamJsonInput = hasImages;
        const args = this.buildArgs(options, useStreamJsonInput);
        const timeout = options.timeout || DEFAULT_TIMEOUT;
        return new Promise((resolve, reject) => {
            try {
                const spawnEnv = { ...process.env };
                delete spawnEnv["CLAUDECODE"]; // prevent nested-session rejection
                // On Windows, use shell:true so claude.cmd is resolved via PATH.
                // Note: shell:true routes through cmd.exe which may affect encoding,
                // but is required for .cmd file execution.
                this.process = spawn("claude", args, {
                    cwd: options.cwd || process.cwd(),
                    env: spawnEnv,
                    stdio: ["pipe", "pipe", "pipe"],
                    shell: process.platform === "win32",
                    windowsHide: true,
                });
                // Set timeout with SIGKILL fallback for Windows
                this.timeoutId = setTimeout(() => {
                    if (!this.isKilled) {
                        this.isKilled = true;
                        this.process?.kill("SIGTERM");
                        // Windows: SIGTERM may not kill child trees; force kill after 5s
                        setTimeout(() => {
                            try { this.process?.kill("SIGKILL"); } catch (e) {}
                            if (process.platform === "win32" && this.process?.pid) {
                                try {
                                    require("child_process").execSync(
                                        `taskkill /F /T /PID ${this.process.pid}`,
                                        { stdio: "ignore", timeout: 5000 }
                                    );
                                } catch (e) {}
                            }
                        }, 5000);
                        this.emit("error", new Error(`Request timed out after ${timeout}ms`));
                    }
                }, timeout);
                // Handle spawn errors
                this.process.on("error", (err) => {
                    this.clearTimeout();
                    if (err.message.includes("ENOENT")) {
                        reject(new Error("Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"));
                    }
                    else {
                        reject(err);
                    }
                });
                // Write input to stdin
                if (useStreamJsonInput) {
                    const content = [];
                    if (prompt) content.push({ type: "text", text: prompt });
                    if (hasImages) content.push(...options.imageParts);
                    const jsonLine = JSON.stringify({
                        type: "user",
                        message: { role: "user", content },
                    });
                    console.error(`[Subprocess] stream-json input (${jsonLine.length} chars)`);
                    this.process.stdin?.write(jsonLine + "\n", "utf8");
                } else {
                    this.process.stdin?.write(prompt, "utf8");
                }
                this.process.stdin?.end();
                console.error(`[Subprocess] PID: ${this.process.pid}, model: ${options.model}`);
                // Parse JSON stream from stdout
                this.process.stdout?.on("data", (chunk) => {
                    this.buffer += chunk.toString();
                    this.processBuffer();
                });
                // Capture stderr for debugging
                this.process.stderr?.on("data", (chunk) => {
                    const errorText = chunk.toString().trim();
                    if (errorText) {
                        console.error("[Subprocess stderr]:", errorText.slice(0, 200));
                    }
                });
                // Handle process close
                this.process.on("close", (code) => {
                    console.error(`[Subprocess] Closed with code: ${code}`);
                    this.clearTimeout();
                    if (this.buffer.trim()) {
                        this.processBuffer();
                    }
                    this.emit("close", code);
                });
                resolve();
            }
            catch (err) {
                this.clearTimeout();
                reject(err);
            }
        });
    }
    /**
     * Build CLI arguments array
     */
    buildArgs(options, useStreamJsonInput = false) {
        const args = [
            "--print",
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--model", options.model,
            "--no-session-persistence",
            "--permission-mode", "bypassPermissions",
            "--tools", "default",
            "--max-budget-usd", "5",
        ];
        if (useStreamJsonInput) {
            args.push("--input-format", "stream-json");
        }
        // NOTE: System prompts from OpenAI format are embedded in the prompt text
        // (via <system_instructions> tags) instead of --append-system-prompt because:
        // 1. shell:true on Windows doesn't escape args → command injection risk
        // 2. Windows cmd.exe has ~8191 char limit → ENAMETOOLONG for long prompts
        // 3. Prompt text is passed via stdin (safe for any length and encoding)
        // NOTE: Claude CLI --print mode has no --max-tokens flag.
        // max_tokens from OpenAI requests is intentionally NOT mapped to --max-turns
        // (which limits agentic tool-use rounds, NOT output tokens).
        // Output token limits are handled internally by the Claude API.
        // Assign session UUID for tracking (even without --resume)
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (options.sessionId && UUID_RE.test(options.sessionId)) {
            args.push("--session-id", options.sessionId);
        }
        return args;
    }
    /**
     * Process the buffer and emit parsed messages
     */
    processBuffer() {
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const message = JSON.parse(trimmed);
                this.emit("message", message);
                if (isContentDelta(message)) {
                    this.emit("content_delta", message);
                }
                else if (isAssistantMessage(message)) {
                    this.emit("assistant", message);
                }
                else if (isResultMessage(message)) {
                    this.emit("result", message);
                }
            }
            catch {
                this.emit("raw", trimmed);
            }
        }
    }
    clearTimeout() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
    }
    kill(signal = "SIGTERM") {
        if (!this.isKilled && this.process) {
            this.isKilled = true;
            this.clearTimeout();
            this.process.kill(signal);
        }
    }
    isRunning() {
        return this.process !== null && !this.isKilled && this.process.exitCode === null;
    }
}
/**
 * Verify that Claude CLI is installed and accessible
 */
export async function verifyClaude() {
    return new Promise((resolve) => {
        const proc = spawn("claude", ["--version"], {
            stdio: "pipe",
            shell: process.platform === "win32",
            windowsHide: true,
        });
        let output = "";
        proc.stdout?.on("data", (chunk) => {
            output += chunk.toString();
        });
        proc.on("error", () => {
            resolve({
                ok: false,
                error: "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
            });
        });
        proc.on("close", (code) => {
            if (code === 0) {
                resolve({ ok: true, version: output.trim() });
            }
            else {
                resolve({
                    ok: false,
                    error: "Claude CLI returned non-zero exit code",
                });
            }
        });
    });
}
export async function verifyAuth() {
    return { ok: true };
}
//# sourceMappingURL=manager.js.map
