#!/usr/bin/env node
/**
 * Paautin AI — Companion Server
 *
 * Local HTTP server that wraps the claude CLI for the Node-RED sidebar plugin.
 * Run on the same machine where you have claude CLI installed.
 *
 * Usage:
 *   npx paautin-ai-companion [--port 3100] [--project /path/to/project]
 *   node companion-server.js [--port 3100] [--project /path/to/project]
 */
const http = require("http");
const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ── Parse CLI args ──────────────────────────────────────────────
function parseArgs(argv) {
    const args = { port: 3100, project: process.cwd() };
    for (let i = 2; i < argv.length; i++) {
        if ((argv[i] === "--port" || argv[i] === "-p") && argv[i + 1]) {
            args.port = parseInt(argv[++i], 10);
        } else if ((argv[i] === "--project" || argv[i] === "-d") && argv[i + 1]) {
            args.project = path.resolve(argv[++i]);
        } else if (argv[i] === "--help" || argv[i] === "-h") {
            console.log(
                "Usage: paautin-ai-companion [options]\n\n" +
                "Options:\n" +
                "  --port, -p <port>       HTTP port (default: 3100)\n" +
                "  --project, -d <path>    Project directory for claude CLI (default: cwd)\n" +
                "  --help, -h              Show this help\n"
            );
            process.exit(0);
        }
    }
    return args;
}

const config = parseArgs(process.argv);

// ── Find claude CLI binary ─────────────────────────────────────
function findClaude() {
    // 1. Check if 'claude' is in PATH
    try {
        var p = execSync("which claude", { encoding: "utf8" }).trim();
        if (p && fs.existsSync(p)) return p;
    } catch (_e) {}

    // 2. Check VS Code extension (common location)
    var home = os.homedir();
    var vscodeDirs = [
        path.join(home, ".vscode", "extensions"),
        path.join(home, ".vscode-insiders", "extensions"),
    ];
    for (var dir of vscodeDirs) {
        try {
            var exts = fs.readdirSync(dir).filter(function (d) {
                return d.startsWith("anthropic.claude-code-");
            }).sort().reverse(); // newest first
            for (var ext of exts) {
                var bin = path.join(dir, ext, "resources", "native-binary", "claude");
                if (fs.existsSync(bin)) return bin;
            }
        } catch (_e) {}
    }

    // 3. Common install paths
    var paths = [
        path.join(home, ".claude", "local", "bin", "claude"),
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
    ];
    for (var p of paths) {
        if (fs.existsSync(p)) return p;
    }

    return null;
}

var claudePath = findClaude();
if (!claudePath) {
    console.error("ERROR: claude CLI not found. Install it or add it to PATH.");
    process.exit(1);
}

// ── CORS headers ────────────────────────────────────────────────
function setCORS(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
}

// ── Read request body ───────────────────────────────────────────
function readBody(req) {
    return new Promise(function (resolve, reject) {
        var chunks = [];
        req.on("data", function (c) { chunks.push(c); });
        req.on("end", function () { resolve(Buffer.concat(chunks).toString()); });
        req.on("error", reject);
    });
}

// ── SSE helpers ─────────────────────────────────────────────────
function sseWrite(res, type, content) {
    res.write("data: " + JSON.stringify({ type: type, content: content }) + "\n\n");
}

// ── Handle /chat ────────────────────────────────────────────────
async function handleChat(req, res) {
    console.log("[chat] Request received");
    var body;
    try {
        body = JSON.parse(await readBody(req));
    } catch (_e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
    }

    var prompt = body.prompt || "";
    var flowContext = body.flowContext || null;
    var history = body.history || [];

    if (!prompt) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing prompt" }));
        return;
    }

    // Build full prompt with conversation history
    var fullPrompt = "";

    // Prepend flow context if provided
    if (flowContext && flowContext.nodes && flowContext.nodes.length > 0) {
        fullPrompt +=
            "Context — active Node-RED flow (tab: " +
            (flowContext.tabLabel || flowContext.tabId) +
            ", " + flowContext.nodeCount + " nodes):\n```json\n" +
            JSON.stringify(flowContext.nodes) +
            "\n```\n\n";
    }

    // Prepend conversation history
    if (history.length > 0) {
        fullPrompt += "Conversation history:\n";
        history.forEach(function (msg) {
            var role = msg.role === "user" ? "User" : "Assistant";
            var content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
            // Truncate long messages to save tokens
            if (content.length > 500) content = content.substring(0, 500) + "...";
            fullPrompt += role + ": " + content + "\n";
        });
        fullPrompt += "\nCurrent message:\n";
    }

    fullPrompt += prompt;

    // SSE headers
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    });

    // Write prompt to temp file (avoids shell escaping issues)
    var ts = Date.now();
    var tmpPrompt = path.join(os.tmpdir(), "claude-prompt-" + ts + ".txt");
    var tmpOut = path.join(os.tmpdir(), "claude-out-" + ts + ".jsonl");
    fs.writeFileSync(tmpPrompt, fullPrompt);

    // Build minimal clean env
    var childEnv = {
        HOME: os.homedir(),
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
        USER: process.env.USER || "",
        LANG: process.env.LANG || "en_US.UTF-8",
        TERM: "xterm-256color",
    };

    // Spawn claude via bash with file redirect — the binary doesn't produce
    // output when stdout is a Node.js pipe, but works with file redirection
    var cmd = "'" + claudePath + "'" +
        " -p \"$(cat '" + tmpPrompt + "')\"" +
        " --output-format stream-json --verbose" +
        " --max-turns 10 --model sonnet --no-session-persistence" +
        " > '" + tmpOut + "' 2>&1";
    console.log("[chat] Output file:", tmpOut);

    var proc = spawn("/bin/bash", ["-c", cmd], {
        cwd: config.project,
        env: childEnv,
        stdio: "ignore",
        detached: true,
    });
    var procPid = proc.pid;
    proc.unref();
    console.log("[chat] Spawned PID:", procPid);

    // Poll the output file for new lines
    var closed = false;
    var bytesRead = 0;
    var lineBuffer = "";

    req.on("close", function () {
        closed = true;
        // Kill the detached process group
        try { process.kill(-procPid, "SIGTERM"); } catch (_e) {}
        cleanup();
    });

    function cleanup() {
        try { fs.unlinkSync(tmpPrompt); } catch (_e) {}
        try { fs.unlinkSync(tmpOut); } catch (_e) {}
    }

    function processLine(line) {
        if (!line.trim()) return;
        try {
            var evt = JSON.parse(line);
            if (evt.type === "assistant" && evt.message && Array.isArray(evt.message.content)) {
                evt.message.content.forEach(function (block) {
                    if (block.type === "text") {
                        sseWrite(res, "text", block.text);
                    } else if (block.type === "tool_use") {
                        sseWrite(res, "tool_use", { tool: block.name, input: block.input });
                    }
                });
            } else if (evt.type === "result") {
                if (evt.result) sseWrite(res, "result", evt.result);
                if (evt.total_cost_usd !== undefined) sseWrite(res, "cost", evt.total_cost_usd);
            }
        } catch (_e) { /* skip non-JSON lines */ }
    }

    function pollFile() {
        if (closed) return;

        var fileSize = 0;
        try {
            var stat = fs.statSync(tmpOut);
            fileSize = stat.size;
        } catch (_e) {
            // File doesn't exist yet — keep polling
            setTimeout(pollFile, 200);
            return;
        }

        if (fileSize > bytesRead) {
            var fd = fs.openSync(tmpOut, "r");
            var buf = Buffer.alloc(fileSize - bytesRead);
            fs.readSync(fd, buf, 0, buf.length, bytesRead);
            fs.closeSync(fd);
            bytesRead = fileSize;

            lineBuffer += buf.toString();
            var lines = lineBuffer.split("\n");
            lineBuffer = lines.pop(); // keep incomplete last line

            lines.forEach(processLine);
        }

        // Check if process is still alive
        var alive = false;
        try { process.kill(procPid, 0); alive = true; } catch (_e) {}

        if (!alive && fileSize <= bytesRead) {
            // Process ended and we've read all output
            if (lineBuffer.trim()) processLine(lineBuffer);
            console.log("[chat] Process finished, total bytes:", bytesRead);
            res.write("data: [DONE]\n\n");
            res.end();
            cleanup();
            return;
        }

        setTimeout(pollFile, 150);
    }

    // Start polling after a short delay
    setTimeout(pollFile, 300);
}

// ── HTTP Server ─────────────────────────────────────────────────
var server = http.createServer(function (req, res) {
    setCORS(res);

    // Preflight
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    // Health check
    if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", project: config.project }));
        return;
    }

    // Chat endpoint
    if (req.method === "POST" && req.url === "/chat") {
        handleChat(req, res);
        return;
    }

    res.writeHead(404);
    res.end("Not found");
});

server.listen(config.port, function () {
    console.log("");
    console.log("  Paautin AI Companion Server");
    console.log("  ──────────────────────────");
    console.log("  Port:    " + config.port);
    console.log("  Project: " + config.project);
    console.log("  Claude:  " + claudePath);
    console.log("  URL:     http://localhost:" + config.port);
    console.log("");
    console.log("  Waiting for requests from Node-RED sidebar...");
    console.log("");
});
