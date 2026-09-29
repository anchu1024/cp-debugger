"use strict";

const OPERATORS = [
    ">>=",
    "<<=",
    "->*",
    "...",
    "<=>",
    "::",
    "->",
    "++",
    "--",
    "<<",
    ">>",
    "<=",
    ">=",
    "==",
    "!=",
    "&&",
    "||",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "&=",
    "|=",
    "^=",
    "##",
];

function tokenizeCpp(source) {
    const tokens = [];
    let index = 0;
    while (index < source.length) {
        const start = index;
        const char = source[index];
        if (/\s/.test(char)) {
            index++;
            continue;
        }
        if (source.startsWith("//", index)) {
            const newline = source.indexOf("\n", index + 2);
            index = newline < 0 ? source.length : newline + 1;
            continue;
        }
        if (source.startsWith("/*", index)) {
            const close = source.indexOf("*/", index + 2);
            index = close < 0 ? source.length : close + 2;
            continue;
        }
        if (char === '"' || char === "'") {
            const quote = char;
            index++;
            while (index < source.length) {
                if (source[index] === "\\") {
                    index += 2;
                    continue;
                }
                if (source[index++] === quote) break;
            }
            tokens.push({
                kind: quote === '"' ? "string" : "character",
                value: source.slice(start, index),
                start,
                end: index,
            });
            continue;
        }
        if (/[A-Za-z_]/.test(char)) {
            index++;
            while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) index++;
            tokens.push({ kind: "identifier", value: source.slice(start, index), start, end: index });
            continue;
        }
        if (/[0-9]/.test(char)) {
            index++;
            while (index < source.length && /[A-Za-z0-9_'.]/.test(source[index])) index++;
            tokens.push({ kind: "number", value: source.slice(start, index), start, end: index });
            continue;
        }
        const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index));
        index += operator ? operator.length : 1;
        tokens.push({ kind: "punctuation", value: source.slice(start, index), start, end: index });
    }
    return tokens;
}

function buildScopes(tokens) {
    const scopes = [{ id: 0, parent: null, start: 0, end: Infinity }];
    const tokenScopes = [];
    const stack = [0];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        tokenScopes[index] = stack[stack.length - 1];
        if (token.value === "{") {
            const id = scopes.length;
            scopes.push({ id, parent: stack[stack.length - 1], start: token.start, end: Infinity });
            stack.push(id);
            tokenScopes[index] = id;
        } else if (token.value === "}" && stack.length > 1) {
            const closed = stack.pop();
            scopes[closed].end = token.end;
            tokenScopes[index] = closed;
        }
    }
    return { scopes, tokenScopes };
}

function analyzeCpp(source) {
    const tokens = tokenizeCpp(source);
    const { scopes, tokenScopes } = buildScopes(tokens);
    const symbols = [];
    const knownTypes = new Set([
        "bool",
        "char",
        "wchar_t",
        "short",
        "int",
        "long",
        "float",
        "double",
        "void",
        "auto",
        "string",
        "vector",
        "array",
        "deque",
        "list",
        "set",
        "multiset",
        "unordered_set",
        "map",
        "multimap",
        "unordered_map",
        "pair",
        "tuple",
        "queue",
        "stack",
        "priority_queue",
    ]);
    for (let index = 1; index + 1 < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind !== "identifier" || !tokens[index - 1] || !tokens[index + 1]) continue;
        let type = null;
        let typeStart = index - 1;
        if ([">", ">>"].includes(tokens[typeStart].value)) {
            let depth = 0;
            for (let cursor = typeStart; cursor >= 0; cursor--) {
                if (tokens[cursor].value === ">") depth++;
                else if (tokens[cursor].value === ">>") depth += 2;
                else if (tokens[cursor].value === "<") depth--;
                if (depth === 0) {
                    typeStart = cursor - 1;
                    break;
                }
            }
            typeStart = Math.max(0, typeStart);
        }
        const typeName = tokens[typeStart].value;
        if (knownTypes.has(typeName))
            type = tokens
                .slice(typeStart, index)
                .map((part) => part.value)
                .join("");
        if (!type) continue;
        const beforeType = tokens[typeStart - 1]?.value;
        if (beforeType && ![";", "{", "}", "(", ",", ":", "using"].includes(beforeType)) continue;
        if (!["=", "(", "[", ";", ",", "{"].includes(tokens[index + 1].value)) continue;
        symbols.push({
            name: token.value,
            type,
            offset: token.start,
            scope: tokenScopes[index],
            initialized: ["=", "{", "("].includes(tokens[index + 1].value),
        });
    }
    return { tokens, scopes, symbols, tokenScopes };
}

function analyzeStaticCpp(source) {
    const analysis = analyzeCpp(source);
    const { tokens, scopes, symbols, tokenScopes } = analysis;
    const diagnostics = [];
    const reported = new Set();
    const scopeDepth = scopes.map((scope) => {
        let depth = 0;
        for (let parent = scope.parent; parent !== null; parent = scopes[parent].parent) depth++;
        return depth;
    });
    const initialized = new Set(symbols.filter((symbol) => symbol.initialized).map((symbol) => symbol.offset));
    const pendingWrites = new Set();
    const reportUninitialized = (symbol, token) => {
        if (reported.has(symbol.offset)) return;
        reported.add(symbol.offset);
        const line = source.slice(0, token.start).split("\n").length;
        const column = token.start - source.lastIndexOf("\n", token.start - 1);
        diagnostics.push({
            rule: "CP001",
            severity: "warning",
            line,
            column,
            message: `CP001: '${symbol.name}' may be read before its first assignment or input.`,
        });
    };
    const visibleSymbol = (name, offset, scopeId) =>
        symbols
            .filter((symbol) => symbol.name === name && symbol.offset < offset)
            .filter((symbol) => {
                for (let scope = scopeId; scope !== null; scope = scopes[scope].parent) {
                    if (scope === symbol.scope) return true;
                }
                return false;
            })
            .sort((left, right) => scopeDepth[right.scope] - scopeDepth[left.scope] || right.offset - left.offset)[0];

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.value === ";") {
            for (const offset of pendingWrites) initialized.add(offset);
            pendingWrites.clear();
            continue;
        }
        if (token.kind !== "identifier") continue;
        const symbol = visibleSymbol(token.value, token.start, tokenScopes[index]);
        if (
            !symbol ||
            symbol.offset === token.start ||
            symbol.scope === 0 ||
            !/^(?:unsigned|signed|long|short|int|float|double|bool|char)/.test(symbol.type)
        )
            continue;
        if ([".", "->"].includes(tokens[index - 1]?.value)) continue;
        const previous = tokens[index - 1]?.value;
        const isInput = tokens[index - 1]?.value === ">>" && tokens[index - 2]?.value === "cin";
        if (isInput) {
            initialized.add(symbol.offset);
            continue;
        }
        const next = tokens[index + 1]?.value;
        if (next === "=" || ["+=", "-=", "*=", "/=", "%="].includes(next)) {
            if (next !== "=" && !initialized.has(symbol.offset)) reportUninitialized(symbol, token);
            pendingWrites.add(symbol.offset);
            continue;
        }
        if (["++", "--"].includes(next) || ["++", "--"].includes(previous)) {
            if (!initialized.has(symbol.offset)) reportUninitialized(symbol, token);
            initialized.add(symbol.offset);
            continue;
        }
        if (!initialized.has(symbol.offset)) reportUninitialized(symbol, token);
    }
    return { ...analysis, diagnostics };
}

module.exports = { tokenizeCpp, analyzeCpp, analyzeStaticCpp };
