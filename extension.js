const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PACKAGE = require("./package.json");
const DIAG_SOURCE = "CP Debugger";
const VERSION = PACKAGE.version;
const REPO_MARKER = "// CP Debugger Repository:";
const VERSION_MARKER = "// CP Debugger Version:";
const DBG_BEGIN = "// CPDBG-BEGIN";
const DBG_END = "// CPDBG-END";

let diagnosticCollection;
let outputChannel;
const sanitizerProbeCache = new Map();

function activate(context) {
    diagnosticCollection = vscode.languages.createDiagnosticCollection(DIAG_SOURCE);
    outputChannel = vscode.window.createOutputChannel("CP Debugger");
    context.subscriptions.push(diagnosticCollection, outputChannel);
    context.subscriptions.push(
        vscode.commands.registerCommand("cpDebugger.debugPrint", () => debugPrint()),
        vscode.commands.registerCommand("cpDebugger.removeDebug", () => removeDebug()),
        vscode.commands.registerCommand("cpDebugger.diagnose", () => diagnose()),
    );
}

function deactivate() {
    if (diagnosticCollection) diagnosticCollection.dispose();
    if (outputChannel) outputChannel.dispose();
}

function isCppDocument(doc) {
    return doc && (doc.languageId === "cpp" || /\.(cc|cpp|cxx|c\+\+)$/.test(doc.fileName));
}

function getEditor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isCppDocument(editor.document)) {
        vscode.window.showErrorMessage("CP Debugger: C++ファイルを開いてください。");
        return null;
    }
    return editor;
}

function config() {
    return vscode.workspace.getConfiguration("cpDebugger");
}

function normalizeGitHubRemote(remote) {
    if (!remote) return null;
    let s = remote.trim();
    if (s.startsWith("git@github.com:")) {
        s = "https://github.com/" + s.slice("git@github.com:".length);
    } else if (s.startsWith("ssh://git@github.com/")) {
        s = "https://github.com/" + s.slice("ssh://git@github.com/".length);
    }
    s = s.replace(/\.git$/, "").replace(/\/$/, "");
    return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/i.test(s) ? s : null;
}

function detectGitHubRepository() {
    const configured = (config().get("repositoryUrl", "") || "").trim();
    if (/^https:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/i.test(configured)) {
        return configured.replace(/\/$/, "");
    }

    const folder = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
    if (!folder) return null;
    const result = commandOutput("git", ["-C", folder.uri.fsPath, "config", "--get", "remote.origin.url"]);
    if (result.status !== 0) return null;
    return normalizeGitHubRemote(result.stdout);
}

function ensureRepositoryMarker(text, edit, repositoryUrl, document) {
    if (!repositoryUrl) return false;
    const hasMarker = /\/\/\s*CP Debugger Repository:\s*https?:\/\/github\.com\//i.test(text);
    const hasUrl = text.toLowerCase().includes(repositoryUrl.toLowerCase());
    if (hasMarker || hasUrl) return false;
    const marker = `${REPO_MARKER} ${repositoryUrl}\n${VERSION_MARKER} ${VERSION}\n`;
    edit.insert(document.uri, new vscode.Position(0, 0), marker);
    return true;
}

function ensureRepositoryMarkerEdit(document) {
    const repositoryUrl = detectGitHubRepository();
    if (!repositoryUrl) return { edit: null, repositoryUrl: null };
    const edit = new vscode.WorkspaceEdit();
    const changed = ensureRepositoryMarker(document.getText(), edit, repositoryUrl, document);
    return { edit: changed ? edit : null, repositoryUrl };
}

function getExpressionAtPosition(document, position) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;
    if (!editor.selection.isEmpty) {
        const selected = document.getText(editor.selection).trim();
        if (selected) return selected;
    }

    const line = document.lineAt(position.line).text;
    const col = Math.min(position.character, line.length);
    const candidates = [];
    const subscriptRe = /[A-Za-z_][A-Za-z0-9_]*(?:\s*\[[^\]]+\])+/g;
    let m;
    while ((m = subscriptRe.exec(line)) !== null) {
        if (m.index <= col && col <= m.index + m[0].length) candidates.push(m[0]);
    }
    if (candidates.length) return candidates.sort((a, b) => b.length - a.length)[0].trim();

    let start = col;
    while (start > 0 && /[A-Za-z0-9_]/.test(line[start - 1])) start--;
    let end = col;
    while (end < line.length && /[A-Za-z0-9_]/.test(line[end])) end++;
    const word = line.slice(start, end);
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(word) ? word : null;
}

function isLikelyKeyword(expr) {
    return new Set([
        "if",
        "else",
        "for",
        "while",
        "do",
        "switch",
        "case",
        "break",
        "continue",
        "return",
        "int",
        "long",
        "short",
        "char",
        "float",
        "double",
        "bool",
        "void",
        "auto",
        "const",
        "static",
        "struct",
        "class",
        "public",
        "private",
        "protected",
        "using",
        "namespace",
        "template",
        "typename",
        "true",
        "false",
        "nullptr",
        "size_t",
        "signed",
        "unsigned",
    ]).has(expr);
}

function inferKind(document, lineNumber, expr) {
    const text = document.getText();
    const before = text.slice(
        0,
        document.offsetAt(new vscode.Position(lineNumber, document.lineAt(lineNumber).text.length)),
    );
    const declRe = new RegExp(
        "(?:^|[;{}\\n])\\s*(?:const\\s+)?(?:std::)?(vector|array|deque|list|set|multiset|unordered_set|map|multimap|unordered_map|pair|string|queue|stack|priority_queue)\\s*<[^;\\n]+>\\s+([A-Za-z_][A-Za-z0-9_]*)",
        "g",
    );
    let d;
    let kind = null;
    while ((d = declRe.exec(before)) !== null) {
        if (d[2] === expr) kind = d[1];
    }
    if (kind) return kind;
    return "scalar";
}

function escapeCppString(s) {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function makeDebugStatement(expr, kind, indent) {
    if (!expr) return null;
    const prefix = `${indent}${DBG_BEGIN} ${expr}\n`;
    const suffix = `\n${indent}${DBG_END}`;
    if (kind === "pair") {
        return `${prefix}${indent}cerr << "[CPDBG] ${escapeCppString(expr)} = (" << (${expr}).first << ", " << (${expr}).second << ")\\n";${suffix}`;
    }
    if (["vector", "array", "deque", "list", "set", "multiset", "unordered_set"].includes(kind)) {
        return `${prefix}${indent}cerr << "[CPDBG] ${escapeCppString(expr)} = ["; { bool __cpdbg_first = true; for (const auto& __cpdbg_v : (${expr})) { if (!__cpdbg_first) cerr << ", "; __cpdbg_first = false; cerr << __cpdbg_v; } } cerr << "]\\n";${suffix}`;
    }
    if (["map", "multimap", "unordered_map"].includes(kind)) {
        return `${prefix}${indent}cerr << "[CPDBG] ${escapeCppString(expr)} = {"; { bool __cpdbg_first = true; for (const auto& __cpdbg_v : (${expr})) { if (!__cpdbg_first) cerr << ", "; __cpdbg_first = false; cerr << "(" << __cpdbg_v.first << ": " << __cpdbg_v.second << ")"; } } cerr << "}\\n";${suffix}`;
    }
    if (["queue", "stack", "priority_queue"].includes(kind)) {
        return `${prefix}${indent}cerr << "[CPDBG] ${escapeCppString(expr)}: container size = " << (${expr}).size() << '\\n';${suffix}`;
    }
    return `${prefix}${indent}cerr << "[CPDBG] ${escapeCppString(expr)} = " << (${expr}) << '\\n';${suffix}`;
}

async function debugPrint() {
    const editor = getEditor();
    if (!editor) return;
    const doc = editor.document;
    const expr = getExpressionAtPosition(doc, editor.selection.active);
    if (!expr || isLikelyKeyword(expr)) {
        vscode.window.showWarningMessage(
            "CP Debugger: 変数または式の上にカーソルを置くか、式を選択して実行してください。",
        );
        return;
    }

    const line = editor.selection.active.line;
    const lineText = doc.lineAt(line).text;
    const indent = (lineText.match(/^\s*/) || [""])[0];
    if (/^\s*(if|for|while|switch)\s*\([^;]*\)\s*$/.test(lineText.trim()) || /\belse\s*$/.test(lineText.trim())) {
        vscode.window.showWarningMessage("CP Debugger: 制御文ヘッダではなく、ブロック内の文の行に置いてください。");
        return;
    }
    if (!lineText.includes(";") && !lineText.includes("{") && !lineText.includes("}")) {
        vscode.window.showWarningMessage("CP Debugger: 文末の ';' がある行で使ってください。");
        return;
    }

    const kind = inferKind(doc, line, expr);
    const statement = makeDebugStatement(expr, kind, indent);
    if (!statement) return;

    const edit = new vscode.WorkspaceEdit();
    ensureRepositoryMarker(doc.getText(), edit, detectGitHubRepository(), doc);
    edit.insert(doc.uri, new vscode.Position(line + 1, 0), statement + "\n");
    const ok = await vscode.workspace.applyEdit(edit);
    if (ok) vscode.window.showInformationMessage(`CP Debugger: ${expr} のデバッグ出力を現在の行の直後に追加しました。`);
}

async function removeDebug() {
    const editor = getEditor();
    if (!editor) return;
    const doc = editor.document;
    const text = doc.getText();
    const begin = escapeRegExp(DBG_BEGIN);
    const end = escapeRegExp(DBG_END);
    const re = new RegExp(`^[ \\t]*${begin}.*\\r?\\n(?:^[ \\t]*.*\\r?\\n)*?^[ \\t]*${end}[ \\t]*\\r?$`, "gm");
    const cleaned = text.replace(re, "");
    if (cleaned === text) {
        vscode.window.showInformationMessage("CP Debugger: 生成したデバッグコードはありません。");
        return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)), cleaned);
    await vscode.workspace.applyEdit(edit);
    vscode.window.showInformationMessage("CP Debugger: 生成したデバッグコードを削除しました。");
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandOutput(command, args) {
    try {
        return cp.spawnSync(command, args, { encoding: "utf8", windowsHide: true, shell: false });
    } catch (e) {
        return { status: null, stdout: "", stderr: String(e), error: e };
    }
}

function findCompiler() {
    const configured = config().get("compiler", "auto");
    if (configured && configured !== "auto") return configured;
    const candidates =
        process.platform === "win32"
            ? [
                  "g++.exe",
                  "C:\\msys64\\mingw64\\bin\\g++.exe",
                  "C:\\msys64\\ucrt64\\bin\\g++.exe",
                  "C:\\mingw64\\bin\\g++.exe",
                  "C:\\Program Files\\mingw64\\bin\\g++.exe",
                  "C:\\Program Files (x86)\\mingw64\\bin\\g++.exe",
              ]
            : ["g++"];

    for (const candidate of candidates) {
        if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
        if (!path.isAbsolute(candidate)) {
            const result = commandOutput(process.platform === "win32" ? "where" : "which", [candidate]);
            if (result.status === 0 && result.stdout.trim()) return result.stdout.trim().split(/\r?\n/)[0].trim();
        }
    }
    return null;
}

function getCompilerVersion(compiler) {
    const result = commandOutput(compiler, ["--version"]);
    return (result.stdout || "").split(/\r?\n/)[0].trim() || "unknown";
}

function compilerCanRun(executable) {
    const result = cp.spawnSync(executable, [], { encoding: "utf8", windowsHide: true, timeout: 2000 });
    return result.error ? false : true;
}

function probeSanitizers(compiler, standard) {
    const cacheKey = `${compiler}\n${standard}`;
    if (sanitizerProbeCache.has(cacheKey)) return sanitizerProbeCache.get(cacheKey);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-debugger-probe-"));
    const source = path.join(tempDir, "probe.cpp");
    const exe = path.join(tempDir, process.platform === "win32" ? "probe.exe" : "probe");
    fs.writeFileSync(source, "int main() { return 0; }\n", "utf8");

    const args = [
        `-${standard}`,
        "-g",
        "-O0",
        "-fno-omit-frame-pointer",
        "-fsanitize=address,undefined",
        source,
        "-o",
        exe,
    ];
    const result = commandOutput(compiler, args);
    let works = result.status === 0 && fs.existsSync(exe);
    let launchError = "";

    if (works) {
        const run = cp.spawnSync(exe, [], {
            cwd: tempDir,
            encoding: "utf8",
            windowsHide: true,
            timeout: 2000,
        });
        if (run.error || run.status !== 0) {
            works = false;
            launchError = (run.stderr || run.stdout || run.error?.message || "").trim();
        }
    }

    const info = {
        available: works,
        compileOutput: `${result.stdout || ""}${result.stderr || ""}`.trim(),
        launchError,
    };
    sanitizerProbeCache.set(cacheKey, info);
    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
    return info;
}

function buildPlan(source, output, compiler) {
    const standard = config().get("cxxStandard", "gnu++23");
    const mode = config().get("debugMode", "auto");
    const enableSan = config().get("enableSanitizers", true);
    const args = [`-${standard}`, "-g", "-O0", source, "-o", output];

    if ((mode === "auto" || mode === "sanitizer") && enableSan) {
        const probe = probeSanitizers(compiler, standard);
        if (probe.available) {
            args.push("-fsanitize=address,undefined", "-fno-omit-frame-pointer");
            return { args, modeUsed: "sanitizer", sanitizer: true, probe };
        }
        if (mode === "sanitizer") {
            return {
                args: null,
                modeUsed: "sanitizer",
                sanitizer: false,
                error: "設定されたg++ではASan+UBSanを実際にコンパイル・リンク・起動できません。clang++には切り替えません。",
            };
        }
    }

    if (mode === "auto" || mode === "libstdc++-debug") {
        args.push("-D_GLIBCXX_DEBUG", "-D_GLIBCXX_ASSERTIONS");
        return { args, modeUsed: "libstdc++-debug", sanitizer: false };
    }
    return { args, modeUsed: "plain", sanitizer: false };
}

function parseLocation(line) {
    // GCC diagnostics: C:\\path\\main.cpp:37:12: error: ...
    let m = line.match(/^(.*?\.cpp):(\d+):(\d+):\s*(error|warning|note):\s*(.*)$/i);
    if (m) return { file: m[1], line: Number(m[2]), column: Number(m[3]), message: `${m[4]}: ${m[5]}` };

    // GCC/ASan stack frames often contain: ... main.cpp:37:12 ...
    m = line.match(/((?:[A-Za-z]:[\\/])?[^\s()]+\.cpp):(\d+)(?::(\d+))?/i);
    if (m) {
        const kind = /warning|runtime error|AddressSanitizer|UndefinedBehaviorSanitizer|ubsan/i.test(line)
            ? vscode.DiagnosticSeverity.Error
            : null;
        if (kind !== null) return { file: m[1], line: Number(m[2]), column: Number(m[3] || 1), message: line.trim() };
    }
    return null;
}

function parseDiagnostics(raw, defaultFile) {
    const result = [];
    for (const line of raw.split(/\r?\n/)) {
        const parsed = parseLocation(line);
        if (parsed) result.push(parsed);
    }
    if (!result.length && raw.trim()) {
        const sanitizerSummary = raw.match(
            /(AddressSanitizer[^\n]*|runtime error:[^\n]*|UndefinedBehaviorSanitizer[^\n]*)/i,
        );
        if (sanitizerSummary)
            result.push({ file: defaultFile, line: 1, column: 1, message: sanitizerSummary[1].trim() });
    }
    return dedupeDiagnostics(result);
}

function dedupeDiagnostics(list) {
    const seen = new Set();
    return list.filter((d) => {
        const key = `${d.file}|${d.line}|${d.column}|${d.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function resolveDiagnosticFile(file, source) {
    if (!file) return source;
    const normalized = file.replace(/^file:\/\//i, "");
    if (path.isAbsolute(normalized)) return normalized;
    return path.resolve(path.dirname(source), normalized);
}

function publishDiagnostics(source, diagnostics, severity = vscode.DiagnosticSeverity.Error) {
    if (!diagnosticCollection) return;
    const byFile = new Map();
    for (const d of diagnostics) {
        const file = resolveDiagnosticFile(d.file, source);
        const uri = vscode.Uri.file(file);
        const arr = byFile.get(uri.toString()) || [];
        const s = d.severity !== undefined ? d.severity : severity;
        const line = Math.max(0, Number(d.line || 1) - 1);
        const col = Math.max(0, Number(d.column || 1) - 1);
        const diag = new vscode.Diagnostic(new vscode.Range(line, col, line, col + 1), d.message, s);
        diag.source = DIAG_SOURCE;
        arr.push(diag);
        byFile.set(uri.toString(), arr);
    }
    diagnosticCollection.clear();
    for (const [key, arr] of byFile) diagnosticCollection.set(vscode.Uri.parse(key), arr);
}

function readInputFile(source) {
    const configured = (config().get("inputFile", "") || "").trim();
    const candidate = configured
        ? configured
        : path.join(path.dirname(source), path.basename(source, path.extname(source)) + ".in");
    if (!fs.existsSync(candidate)) return { path: null, data: "" };
    return { path: candidate, data: fs.readFileSync(candidate) };
}

function runProgram(executable, inputData, timeoutMs, cwd) {
    return new Promise((resolve) => {
        const child = cp.spawn(executable, [], {
            cwd,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let done = false;
        let timer;
        const finish = (result) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(result);
        };
        child.stdout.on("data", (b) => (stdout += b.toString()));
        child.stderr.on("data", (b) => (stderr += b.toString()));
        child.on("error", (err) => finish({ code: -1, stdout, stderr, error: err, timedOut: false }));
        child.on("close", (code) => finish({ code, stdout, stderr, error: null, timedOut: false }));
        timer = setTimeout(() => {
            try {
                child.kill();
            } catch (_) {}
            finish({ code: null, stdout, stderr, error: null, timedOut: true });
        }, timeoutMs);
        child.stdin.end(inputData);
    });
}

async function diagnose() {
    const editor = getEditor();
    if (!editor) return;
    await editor.document.save();
    const source = editor.document.fileName;
    const compiler = findCompiler();
    diagnosticCollection.clear();
    if (!compiler) {
        vscode.window.showErrorMessage(
            "CP Debugger: g++ が見つかりません。cpDebugger.compiler に g++.exe のフルパスを設定してください。",
        );
        return;
    }

    // Using the debugger itself is also a use of the tool, so add the local GitHub marker if available.
    const markerUrl = detectGitHubRepository();
    if (markerUrl) {
        const edit = new vscode.WorkspaceEdit();
        if (ensureRepositoryMarker(editor.document.getText(), edit, markerUrl)) {
            await vscode.workspace.applyEdit(edit);
            await editor.document.save();
        }
    }

    const standard = config().get("cxxStandard", "gnu++23");
    const compilerVersion = getCompilerVersion(compiler);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-debugger-"));
    const exe = path.join(tempDir, process.platform === "win32" ? "main.exe" : "main");
    const plan = buildPlan(source, exe, compiler);

    outputChannel.clear();
    outputChannel.appendLine(`Compiler: ${compiler}`);
    outputChannel.appendLine(`Version: ${compilerVersion}`);
    outputChannel.appendLine(`Standard: ${standard}`);
    outputChannel.appendLine(`Debug mode: ${plan.modeUsed}`);
    if (plan.modeUsed === "libstdc++-debug") {
        outputChannel.appendLine("Sanitizer: unavailable -> using _GLIBCXX_DEBUG + _GLIBCXX_ASSERTIONS");
    } else if (plan.modeUsed === "sanitizer") {
        outputChannel.appendLine("Sanitizer: ASan + UBSan enabled");
    }
    if (plan.error) {
        outputChannel.appendLine(`ERROR: ${plan.error}`);
        if (plan.probe?.compileOutput) outputChannel.appendLine(plan.probe.compileOutput);
        outputChannel.show(true);
        vscode.window.showErrorMessage(`CP Debugger: ${plan.error}`);
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (_) {}
        return;
    }

    const compilerResult = commandOutput(compiler, plan.args);
    const compileRaw = `${compilerResult.stdout || ""}\n${compilerResult.stderr || ""}`.trim();
    if (compilerResult.status !== 0) {
        const diagnostics = parseDiagnostics(compileRaw, source);
        publishDiagnostics(
            source,
            diagnostics.length
                ? diagnostics
                : [{ file: source, line: 1, column: 1, message: compileRaw || "g++のコンパイルに失敗しました。" }],
        );
        outputChannel.appendLine("--- compile ---");
        outputChannel.appendLine(compileRaw);
        outputChannel.show(true);
        vscode.window.showErrorMessage(`CP Debugger: コンパイル失敗 (${path.basename(source)})`);
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (_) {}
        return;
    }

    const input = readInputFile(source);
    const timeout = config().get("timeoutMs", 5000);
    const result = await runProgram(exe, input.data, timeout, path.dirname(source));
    const raw = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    const diagnostics = parseDiagnostics(raw, source);

    if (result.timedOut) {
        publishDiagnostics(source, [
            {
                file: source,
                line: 1,
                column: 1,
                message: `実行がタイムアウトしました (${timeout} ms)`,
                severity: vscode.DiagnosticSeverity.Warning,
            },
        ]);
    } else if (result.code !== 0) {
        publishDiagnostics(
            source,
            diagnostics.length
                ? diagnostics
                : [
                      {
                          file: source,
                          line: 1,
                          column: 1,
                          message: `Runtime Error: exit code ${result.code}\n${result.stderr || ""}`,
                      },
                  ],
        );
    } else {
        diagnosticCollection.clear();
    }

    outputChannel.appendLine(`Input: ${input.path ? input.path : "stdin (empty)"}`);
    outputChannel.appendLine(result.timedOut ? "Result: TIMEOUT" : `Result: exit ${result.code}`);
    if (result.stdout) {
        outputChannel.appendLine("--- stdout ---");
        outputChannel.append(result.stdout);
        if (!result.stdout.endsWith("\n")) outputChannel.appendLine();
    }
    if (result.stderr) {
        outputChannel.appendLine("--- stderr ---");
        outputChannel.append(result.stderr);
        if (!result.stderr.endsWith("\n")) outputChannel.appendLine();
    }
    outputChannel.show(true);

    if (result.code === 0 && !result.timedOut) {
        vscode.window.showInformationMessage(`CP Debugger: 実行成功 (${plan.modeUsed})`);
    } else if (result.timedOut) {
        vscode.window.showWarningMessage("CP Debugger: タイムアウトしました。");
    } else {
        vscode.window.showErrorMessage(`CP Debugger: Runtime Error (exit ${result.code})`);
    }

    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
}

module.exports = { activate, deactivate };
