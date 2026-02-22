/**
 * node-red-plugin-paautin-ai
 * Runtime: config node + HTTP admin routes for AI chat
 *
 * Three modes:
 *   simple      — Direct Anthropic API (just needs API key)
 *   claude-code — Spawns local claude CLI (needs claude installed)
 *   server      — Proxies to a remote Claude Code endpoint
 */
module.exports = function (RED) {
    const https = require("https");
    const http = require("http");
    const { spawn } = require("child_process");

    // ── Config node ─────────────────────────────────────────────
    function PaautinAIConfigNode(config) {
        RED.nodes.createNode(this, config);
        this.mode = config.mode || "simple";
        this.model = config.model || "claude-sonnet-4-20250514";
        this.serverUrl = config.serverUrl || "";
        this.projectPath = config.projectPath || "";
        this.includeSkills = config.includeSkills !== false;
    }

    RED.nodes.registerType("paautin-ai-config", PaautinAIConfigNode, {
        credentials: {
            apiKey: { type: "password" },
        },
    });

    // ── Helpers ─────────────────────────────────────────────────
    function getConfigNode() {
        var found = null;
        RED.nodes.eachNode(function (n) {
            if (n.type === "paautin-ai-config" && !found) {
                found = RED.nodes.getNode(n.id);
            }
        });
        return found;
    }

    function sseWrite(res, type, content) {
        res.write(
            "data: " + JSON.stringify({ type: type, content: content }) + "\n\n"
        );
    }

    function sseEnd(res) {
        res.write("data: [DONE]\n\n");
        res.end();
    }

    // ── HTTP Admin Routes ───────────────────────────────────────

    // GET /paautin-ai/config — return non-secret config to the editor
    RED.httpAdmin.get("/paautin-ai/config", function (_req, res) {
        var cfg = getConfigNode();
        if (!cfg) {
            return res.json({
                mode: "simple",
                model: "claude-sonnet-4-20250514",
                hasApiKey: false,
            });
        }
        res.json({
            mode: cfg.mode,
            model: cfg.model,
            serverUrl: cfg.serverUrl,
            projectPath: cfg.projectPath,
            includeSkills: cfg.includeSkills,
            hasApiKey: !!(cfg.credentials && cfg.credentials.apiKey),
        });
    });

    // POST /paautin-ai/chat — streaming chat endpoint
    RED.httpAdmin.post("/paautin-ai/chat", function (req, res) {
        var cfg = getConfigNode();
        var mode = req.body.mode || (cfg ? cfg.mode : "simple");
        var messages = req.body.messages || [];
        var flowContext = req.body.flowContext || null;

        // SSE headers
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");

        if (mode === "simple") {
            handleSimpleMode(cfg, messages, flowContext, res);
        } else if (mode === "claude-code") {
            handleClaudeCodeMode(cfg, messages, flowContext, res);
        } else if (mode === "server") {
            handleServerMode(cfg, messages, flowContext, res);
        } else {
            sseWrite(res, "error", "Unknown mode: " + mode);
            sseEnd(res);
        }
    });

    // ── Mode: Simple (Direct Anthropic API) ─────────────────────
    function handleSimpleMode(cfg, messages, flowContext, res) {
        var apiKey = cfg && cfg.credentials ? cfg.credentials.apiKey : "";
        var model = cfg ? cfg.model : "claude-sonnet-4-20250514";

        if (!apiKey) {
            sseWrite(res, "error", "API Key no configurada. Agrega un nodo de configuracion paautin-ai-config.");
            sseEnd(res);
            return;
        }

        var systemPrompt = buildSystemPrompt(flowContext);
        var apiMessages = messages.map(function (m) {
            return { role: m.role, content: m.content };
        });

        var postData = JSON.stringify({
            model: model,
            max_tokens: 8192,
            system: systemPrompt,
            messages: apiMessages,
            stream: true,
        });

        var options = {
            hostname: "api.anthropic.com",
            path: "/v1/messages",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            },
        };

        var apiReq = https.request(options, function (apiRes) {
            if (apiRes.statusCode !== 200) {
                var errBody = "";
                apiRes.on("data", function (c) { errBody += c; });
                apiRes.on("end", function () {
                    sseWrite(res, "error", "Anthropic API error (" + apiRes.statusCode + "): " + errBody);
                    sseEnd(res);
                });
                return;
            }

            var buffer = "";
            apiRes.on("data", function (chunk) {
                buffer += chunk.toString();
                var lines = buffer.split("\n");
                buffer = lines.pop();

                lines.forEach(function (line) {
                    if (!line.startsWith("data: ")) return;
                    var data = line.slice(6).trim();
                    if (!data || data === "[DONE]") return;

                    try {
                        var evt = JSON.parse(data);
                        if (
                            evt.type === "content_block_delta" &&
                            evt.delta &&
                            evt.delta.type === "text_delta"
                        ) {
                            sseWrite(res, "text", evt.delta.text);
                        }
                    } catch (_e) { /* skip malformed lines */ }
                });
            });

            apiRes.on("end", function () {
                sseEnd(res);
            });

            apiRes.on("error", function (err) {
                sseWrite(res, "error", "Stream error: " + err.message);
                sseEnd(res);
            });
        });

        apiReq.on("error", function (err) {
            sseWrite(res, "error", "Request failed: " + err.message);
            sseEnd(res);
        });

        apiReq.write(postData);
        apiReq.end();
    }

    // ── Mode: Claude Code (Local CLI) ───────────────────────────
    function handleClaudeCodeMode(cfg, messages, flowContext, res) {
        var projectPath = cfg ? cfg.projectPath : "";
        if (!projectPath) {
            projectPath = RED.settings.userDir || process.cwd();
        }

        var lastMessage = messages[messages.length - 1];
        if (!lastMessage) {
            sseWrite(res, "error", "No message provided");
            sseEnd(res);
            return;
        }

        // Build prompt with flow context
        var prompt = lastMessage.content;
        if (flowContext && flowContext.nodes && flowContext.nodes.length > 0) {
            prompt =
                "Context — active Node-RED flow (tab " + flowContext.tabId + "):\n" +
                "```json\n" +
                JSON.stringify(flowContext.nodes, null, 2) +
                "\n```\n\n" +
                prompt;
        }

        var args = ["-p", prompt, "--output-format", "stream-json", "--max-turns", "10"];

        var proc;
        try {
            proc = spawn("claude", args, {
                cwd: projectPath,
                env: Object.assign({}, process.env),
            });
        } catch (err) {
            sseWrite(res, "error", "No se pudo iniciar claude CLI: " + err.message);
            sseEnd(res);
            return;
        }

        var buffer = "";

        proc.stdout.on("data", function (data) {
            buffer += data.toString();
            var lines = buffer.split("\n");
            buffer = lines.pop();

            lines.forEach(function (line) {
                if (!line.trim()) return;
                try {
                    var evt = JSON.parse(line);
                    handleClaudeCodeEvent(evt, res);
                } catch (_e) { /* skip */ }
            });
        });

        proc.stderr.on("data", function (data) {
            RED.log.warn("paautin-ai claude-code stderr: " + data.toString().trim());
        });

        proc.on("close", function () {
            sseEnd(res);
        });

        proc.on("error", function (err) {
            sseWrite(res, "error", "claude CLI error: " + err.message);
            sseEnd(res);
        });

        // Kill process if client disconnects
        res.on("close", function () {
            if (proc && !proc.killed) {
                proc.kill("SIGTERM");
            }
        });
    }

    function handleClaudeCodeEvent(evt, res) {
        if (evt.type === "assistant" && evt.message && Array.isArray(evt.message.content)) {
            evt.message.content.forEach(function (block) {
                if (block.type === "text") {
                    sseWrite(res, "text", block.text);
                } else if (block.type === "tool_use") {
                    sseWrite(res, "tool_use", {
                        tool: block.name,
                        input: block.input,
                    });
                }
            });
        } else if (evt.type === "result") {
            if (evt.result) {
                sseWrite(res, "result", evt.result);
            }
        }
    }

    // ── Mode: Server (Remote Claude Code endpoint) ──────────────
    function handleServerMode(cfg, messages, flowContext, res) {
        var serverUrl = cfg ? cfg.serverUrl : "";
        if (!serverUrl) {
            sseWrite(res, "error", "URL del servidor no configurada.");
            sseEnd(res);
            return;
        }

        var apiKey = cfg && cfg.credentials ? cfg.credentials.apiKey : "";
        var url;
        try {
            url = new URL(serverUrl.replace(/\/$/, "") + "/chat");
        } catch (err) {
            sseWrite(res, "error", "URL invalida: " + serverUrl);
            sseEnd(res);
            return;
        }

        var postData = JSON.stringify({ messages: messages, flowContext: flowContext });
        var mod = url.protocol === "https:" ? https : http;

        var options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: url.pathname,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            },
        };

        if (apiKey) {
            options.headers["Authorization"] = "Bearer " + apiKey;
        }

        var proxyReq = mod.request(options, function (proxyRes) {
            if (proxyRes.statusCode !== 200) {
                var errBody = "";
                proxyRes.on("data", function (c) { errBody += c; });
                proxyRes.on("end", function () {
                    sseWrite(res, "error", "Server error (" + proxyRes.statusCode + "): " + errBody);
                    sseEnd(res);
                });
                return;
            }
            // Pipe the SSE stream directly
            proxyRes.on("data", function (chunk) {
                res.write(chunk);
            });
            proxyRes.on("end", function () {
                res.end();
            });
        });

        proxyReq.on("error", function (err) {
            sseWrite(res, "error", "Conexion al servidor fallo: " + err.message);
            sseEnd(res);
        });

        proxyReq.write(postData);
        proxyReq.end();

        res.on("close", function () {
            proxyReq.destroy();
        });
    }

    // ── System prompt builder ───────────────────────────────────
    function buildSystemPrompt(flowContext) {
        var prompt =
            "You are a Node-RED expert assistant for the Paautin RPA/Integration platform.\n" +
            "You help users create, modify, debug, and understand Node-RED flows.\n\n" +
            "Key conventions:\n" +
            "- Flow Bricks v3: one JSON file per flow/subflow in flow_bricks/\n" +
            "- Node IDs: 16 hex chars, lowercase, unique across project\n" +
            "- Every flow needs a Catch group (fill #ffbfbf, stroke #ff0000)\n" +
            "- Nodes must have descriptive names (never empty on Function, Debug, Catch)\n" +
            "- Canvas layout: left-to-right, grid-aligned (multiples of 20px)\n" +
            "- Debug nodes: complete=true, targetType=full\n" +
            "- MSSQL: returnType=1, modeOpt=queryMode, parseMustache=true\n" +
            "- Function nodes: use try/catch, node.error(msg, originalMsg), never throw\n" +
            "- Context: prefer most restrictive scope (node > flow > global)\n\n" +
            "When suggesting flow changes, provide valid JSON arrays.\n" +
            "When explaining, be concise and specific to the user's context.\n" +
            "Always respond in the same language the user writes in.";

        if (flowContext && flowContext.nodes && flowContext.nodes.length > 0) {
            prompt +=
                "\n\nThe user is viewing this flow (tab " + flowContext.tabId + "):\n" +
                "```json\n" +
                JSON.stringify(flowContext.nodes, null, 2) +
                "\n```";
        }

        return prompt;
    }
};
