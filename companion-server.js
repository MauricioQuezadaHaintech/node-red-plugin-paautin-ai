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

    if (!prompt) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing prompt" }));
        return;
    }

    // Prepend flow context if provided
    if (flowContext && flowContext.nodes && flowContext.nodes.length > 0) {
        prompt =
            "Context — active Node-RED flow (tab: " +
            (flowContext.tabLabel || flowContext.tabId) +
            ", " + flowContext.nodeCount + " nodes):\n```json\n" +
            JSON.stringify(flowContext.nodes, null, 2) +
            "\n```\n\n" + prompt;
    }

    // SSE headers
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    });

    // Spawn claude CLI
    var proc;
    try {
        var childEnv = Object.assign({}, process.env);
        delete childEnv.CLAUDECODE;
        proc = spawn(claudePath, ["-p", prompt, "--output-format", "stream-json", "--max-turns", "10", "--model", "sonnet", "--no-session-persistence"], {
            cwd: config.project,
            env: childEnv,
        });
    } catch (err) {
        sseWrite(res, "error", "Failed to start claude CLI: " + err.message);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
    }

    var buffer = "";

    proc.stdout.on("data", function (data) {
        buffer += data.toString();
        var lines = buffer.split("\n");
        buffer = lines.pop(); // keep incomplete line in buffer

        lines.forEach(function (line) {
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
                    if (evt.result) {
                        sseWrite(res, "result", evt.result);
                    }
                    if (evt.cost_usd !== undefined) {
                        sseWrite(res, "cost", evt.cost_usd);
                    }
                }
            } catch (_e) { /* skip non-JSON lines */ }
        });
    });

    proc.stderr.on("data", function (data) {
        var msg = data.toString().trim();
        if (msg) console.error("[claude stderr]", msg);
    });

    proc.on("close", function () {
        res.write("data: [DONE]\n\n");
        res.end();
    });

    proc.on("error", function (err) {
        sseWrite(res, "error", "claude CLI error: " + err.message);
        res.write("data: [DONE]\n\n");
        res.end();
    });

    // Kill process if client disconnects
    req.on("close", function () {
        if (proc && !proc.killed) proc.kill("SIGTERM");
    });
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
