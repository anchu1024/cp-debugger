"use strict";

const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { tokenizeCpp, analyzeCpp, analyzeStaticCpp } = require("../lib/cpp-analysis");
const { debugHelperSource } = require("../lib/cpp-debug-helper");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error(`invalid package version: ${pkg.version}`);

const tag = process.env.GITHUB_REF_NAME;
if (tag && /^v\d+\.\d+\.\d+$/.test(tag)) {
    const expected = tag.slice(1);
    if (pkg.version !== expected) throw new Error(`package version ${pkg.version} does not match tag ${tag}`);
}
if (pkg.publisher !== "cp-debugger-local") throw new Error("publisher changed; changing it creates a new extension id");

const source = fs.readFileSync(path.join(root, "extension.js"), "utf8");
const syntax = cp.spawnSync(process.execPath, ["--check", path.join(root, "extension.js")], { encoding: "utf8" });
if (syntax.status !== 0) {
    process.stderr.write(syntax.stderr || syntax.stdout || "syntax check failed\n");
    process.exit(syntax.status || 1);
}

for (const marker of ["CPDBG-BEGIN", "CPDBG-END", "-fsanitize=address,undefined", "_GLIBCXX_DEBUG"]) {
    if (!source.includes(marker)) throw new Error(`missing marker: ${marker}`);
}

const tokens = tokenizeCpp('vector<pair<int,int>> values; // ignored\nconst char* text = "a[i]";');
if (tokens.some((token) => token.value === "ignored" || token.value === "a"))
    throw new Error("lexer did not skip comments/literals");
const analysis = analyzeCpp("int main() { vector<vector<int>> grid; pair<int, int> edge; }");
if (!analysis.scopes.length || !analysis.symbols.some((symbol) => symbol.name === "grid")) {
    throw new Error("token/scope/symbol analysis is missing nested container declarations");
}
const uninitialized = analyzeStaticCpp("int main() { int n; vector<int> values(n); cin >> n; }").diagnostics;
if (uninitialized.length !== 1 || uninitialized[0].rule !== "CP001") {
    throw new Error("CP001 did not report a scalar read before input");
}
if (analyzeStaticCpp("int main() { int n = 10; vector<int> values(n); }").diagnostics.length) {
    throw new Error("CP001 reported an initialized scalar");
}
if (analyzeStaticCpp("int main() { int n(10); vector<int> values(n); }").diagnostics.length) {
    throw new Error("CP001 reported a directly initialized scalar");
}
const incrementRead = analyzeStaticCpp("int main() { int n; n++; n++; }").diagnostics;
if (incrementRead.length !== 1 || incrementRead[0].rule !== "CP001") {
    throw new Error("CP001 did not deduplicate an uninitialized increment read");
}
const helper = debugHelperSource();
if (
    !source.includes("cpdbg::print") ||
    !helper.includes("std::tuple<T...>") ||
    !helper.includes("std::decay_t<T>, std::string")
) {
    throw new Error("generic debug formatter is missing nested/tuple support");
}

if (cp.spawnSync("g++", ["--version"], { encoding: "utf8" }).status === 0) {
    const tempDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "cp-debugger-test-"));
    const cpp = path.join(tempDir, "formatter.cpp");
    const exe = path.join(tempDir, process.platform === "win32" ? "formatter.exe" : "formatter");
    const testProgram = `#include <bits/stdc++.h>\n${helper}\nint main() {\n  std::vector<std::pair<int, int>> values{{1, 2}};\n  auto item = std::make_tuple(7, std::string("cp"), true);\n  cpdbg::print("values", values);\n  cpdbg::print("item", item);\n  cpdbg::print("text", std::string("hello"));\n}\n`;
    try {
        fs.writeFileSync(cpp, testProgram, "utf8");
        const compile = cp.spawnSync("g++", ["-std=gnu++23", cpp, "-o", exe], { encoding: "utf8" });
        if (compile.status !== 0) throw new Error(`formatter compile failed: ${compile.stderr || compile.stdout}`);
        const run = cp.spawnSync(exe, [], { encoding: "utf8" });
        const expected = "[CPDBG] values = [(1, 2)]\n[CPDBG] item = (7, cp, true)\n[CPDBG] text = hello\n";
        if (run.status !== 0 || run.stderr.replace(/\r\n/g, "\n") !== expected)
            throw new Error(`formatter output mismatch: ${run.stderr || run.stdout}`);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

if (/edit\.insert\(new vscode\.Position/.test(source)) {
    throw new Error("invalid WorkspaceEdit.insert signature remains");
}

console.log("CP Debugger smoke test: OK");
