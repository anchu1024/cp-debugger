"use strict";

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

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

if (/edit\.insert\(new vscode\.Position/.test(extensionSource)) {
    throw new Error("invalid WorkspaceEdit.insert signature remains");
}

console.log("CP Debugger smoke test: OK");
