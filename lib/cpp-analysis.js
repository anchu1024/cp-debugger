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
        if (beforeType && ![";", "{", "}", "(", ",", ":", "::", "using"].includes(beforeType)) continue;
        if (!["=", "(", "[", ";", ",", "{"].includes(tokens[index + 1].value)) continue;
        symbols.push({
            name: token.value,
            type,
            offset: token.start,
            scope: tokenScopes[index],
            initialized: ["=", "{", "("].includes(tokens[index + 1].value),
            array: tokens[index + 1].value === "[",
        });
    }
    return { tokens, scopes, symbols, tokenScopes };
}

function matchingToken(tokens, start, open, close) {
    if (tokens[start]?.value !== open) return -1;
    let depth = 0;
    for (let index = start; index < tokens.length; index++) {
        if (tokens[index].value === open) depth++;
        else if (tokens[index].value === close && --depth === 0) return index;
    }
    return -1;
}

function tokenText(tokens, start, end) {
    return tokens
        .slice(start, end)
        .map((token) => token.value)
        .join("");
}

function resolveVisibleSymbol(analysis, name, offset, scopeId) {
    const { symbols, scopes } = analysis;
    const visible = symbols.filter((symbol) => {
        if (symbol.name !== name || symbol.offset > offset) return false;
        for (let scope = scopeId; scope !== null; scope = scopes[scope]?.parent) {
            if (scope === symbol.scope) return true;
        }
        return false;
    });
    return (
        visible.sort((left, right) => {
            if (left.scope !== right.scope) {
                let depth = (scope) => {
                    let count = 0;
                    for (; scope !== null; scope = scopes[scope]?.parent) count++;
                    return count;
                };
                return depth(right.scope) - depth(left.scope);
            }
            return right.offset - left.offset;
        })[0] || null
    );
}

function lineColumn(source, offset) {
    const line = source.slice(0, offset).split("\n").length;
    return { line, column: offset - source.lastIndexOf("\n", offset - 1) };
}

function makeRuleDiagnostic(source, rule, token, message) {
    return { rule, severity: "warning", ...lineColumn(source, token.start), message: `${rule}: ${message}` };
}

function collectContainerSizes(tokens, symbols) {
    const sizes = new Map();
    const containerTypes = /^(?:vector|deque|string|array|std::vector|std::deque|std::string|std::array)/;
    for (const symbol of symbols) {
        if (containerTypes.test(symbol.type)) {
            const fixedArray = symbol.type.match(/^array<.*,(\d+)>$/);
            if (fixedArray) sizes.set(symbol.offset, fixedArray[1]);
            const nameIndex = tokens.findIndex((token) => token.start === symbol.offset);
            if (nameIndex < 0) continue;
            const next = tokens[nameIndex + 1];
            if (next?.value === "[") {
                const close = matchingToken(tokens, nameIndex + 1, "[", "]");
                if (close === nameIndex + 3 && tokens[nameIndex + 2]?.kind === "number") {
                    sizes.set(symbol.offset, tokens[nameIndex + 2].value.replace(/[uUlL]+$/, ""));
                }
            } else if (next?.value === "(") {
                const close = matchingToken(tokens, nameIndex + 1, "(", ")");
                if (close > nameIndex + 2) {
                    const firstComma = tokens.findIndex(
                        (token, index) => index > nameIndex + 1 && index < close && token.value === ",",
                    );
                    const end = firstComma < 0 ? close : firstComma;
                    const sizeExpression = tokenText(tokens, nameIndex + 2, end);
                    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(sizeExpression) || /^\d+[uUlL]*$/.test(sizeExpression)) {
                        sizes.set(symbol.offset, sizeExpression.replace(/[uUlL]+$/, ""));
                    }
                }
            }
        } else if (/^(?:char|short|int|long|float|double|bool)/.test(symbol.type)) {
            const nameIndex = tokens.findIndex((token) => token.start === symbol.offset);
            if (tokens[nameIndex + 1]?.value === "[") {
                const close = matchingToken(tokens, nameIndex + 1, "[", "]");
                if (close === nameIndex + 3 && tokens[nameIndex + 2]?.kind === "number") {
                    sizes.set(symbol.offset, tokens[nameIndex + 2].value.replace(/[uUlL]+$/, ""));
                }
            }
        }
    }
    return sizes;
}

function collectZeroBasedLoops(tokens) {
    const loops = [];
    for (let index = 0; index < tokens.length; index++) {
        if (tokens[index].value !== "for" || tokens[index + 1]?.value !== "(") continue;
        const close = matchingToken(tokens, index + 1, "(", ")");
        if (close < 0) continue;
        const separators = [];
        for (let cursor = index + 2; cursor < close; cursor++) {
            if (tokens[cursor].value === ";") separators.push(cursor);
        }
        if (separators.length !== 2) continue;
        const init = tokens.slice(index + 2, separators[0]);
        const condition = tokens.slice(separators[0] + 1, separators[1]);
        const increment = tokens.slice(separators[1] + 1, close);
        const variableIndex = init.findIndex(
            (token, cursor) => token.kind === "identifier" && init[cursor + 1]?.value === "=",
        );
        if (variableIndex < 0 || init[variableIndex + 2]?.value !== "0") continue;
        const variable = init[variableIndex].value;
        const condIndex = condition.findIndex(
            (token, cursor) => token.value === variable && ["<", "<="].includes(condition[cursor + 1]?.value),
        );
        if (condIndex < 0) continue;
        const operator = condition[condIndex + 1].value;
        const bound = tokenText(condition, condIndex + 2, condition.length);
        const incrementsVariable =
            (increment[0]?.value === "++" && increment[1]?.value === variable) ||
            (increment[0]?.value === variable &&
                ["++", "+="].includes(increment[1]?.value) &&
                (increment[1]?.value === "++" || increment[2]?.value === "1"));
        if (!incrementsVariable || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(bound)) continue;

        let bodyStart = close + 1;
        let bodyEnd = bodyStart;
        if (tokens[bodyStart]?.value === "{") {
            const bodyClose = matchingToken(tokens, bodyStart, "{", "}");
            if (bodyClose < 0) continue;
            bodyEnd = bodyClose;
        } else {
            while (bodyEnd < tokens.length && tokens[bodyEnd].value !== ";") bodyEnd++;
        }
        loops.push({
            variable,
            bound,
            inclusive: operator === "<=",
            start: tokens[bodyStart]?.start ?? tokens[close].end,
            end: tokens[bodyEnd]?.end ?? tokens[close].end,
        });
    }
    return loops;
}

function collectLessThanGuards(tokens) {
    const guards = [];
    for (let index = 0; index < tokens.length; index++) {
        if (tokens[index].value !== "if" || tokens[index + 1]?.value !== "(") continue;
        const close = matchingToken(tokens, index + 1, "(", ")");
        if (close < 0 || close !== index + 5) continue;
        const condition = tokens.slice(index + 2, close);
        if (condition.length !== 3 || condition[1].value !== "<") continue;
        const bodyStart = close + 1;
        let bodyEnd = bodyStart;
        if (tokens[bodyStart]?.value === "{") {
            bodyEnd = matchingToken(tokens, bodyStart, "{", "}");
            if (bodyEnd < 0) continue;
        } else {
            while (bodyEnd < tokens.length && tokens[bodyEnd].value !== ";") bodyEnd++;
        }
        guards.push({
            index: condition[0].value,
            bound: condition[2].value,
            start: tokens[bodyStart]?.start ?? tokens[close].end,
            end: tokens[bodyEnd]?.end ?? tokens[close].end,
        });
    }
    return guards;
}

function analyzeBounds(source, analysis) {
    const { tokens, symbols } = analysis;
    const sizes = collectContainerSizes(tokens, symbols);
    const loops = collectZeroBasedLoops(tokens);
    const guards = collectLessThanGuards(tokens);
    const declarationOffsets = new Set(symbols.filter((symbol) => symbol.array).map((symbol) => symbol.offset));
    const diagnostics = [];
    for (let index = 0; index < tokens.length; index++) {
        if (tokens[index].kind !== "identifier" || tokens[index + 1]?.value !== "[") continue;
        if (declarationOffsets.has(tokens[index].start)) continue;
        const container = tokens[index].value;
        const containerSymbol = resolveVisibleSymbol(
            analysis,
            container,
            tokens[index].start,
            analysis.tokenScopes[index],
        );
        if (
            !containerSymbol ||
            !(
                containerSymbol.array ||
                /^(?:vector|deque|string|array|std::vector|std::deque|std::string|std::array)/.test(
                    containerSymbol.type,
                )
            )
        )
            continue;
        const close = matchingToken(tokens, index + 1, "[", "]");
        if (close < 0) continue;
        const expression = tokens.slice(index + 2, close);
        const size = sizes.get(containerSymbol.offset);
        let reason = null;
        if (expression.length === 2 && expression[0].value === "-" && expression[1].kind === "number") {
            reason = `${container}[${tokenText(tokens, index + 2, close)}] uses a negative index.`;
        } else if (expression.length === 1 && expression[0].kind === "number" && size && /^\d+$/.test(size)) {
            const elementIndex = Number(expression[0].value.replace(/[uUlL]+$/, ""));
            if (elementIndex >= Number(size))
                reason = `${container}[${elementIndex}] is outside its known size ${size}.`;
        } else if (expression.length === 1 && expression[0].kind === "identifier" && size) {
            const loop = loops.find(
                (candidate) =>
                    candidate.variable === expression[0].value &&
                    candidate.bound === size &&
                    candidate.inclusive &&
                    tokens[index].start >= candidate.start &&
                    tokens[close].end <= candidate.end,
            );
            const guarded =
                loop &&
                guards.some(
                    (guard) =>
                        guard.index === loop.variable &&
                        guard.bound === size &&
                        tokens[index].start >= guard.start &&
                        tokens[close].end <= guard.end,
                );
            if (loop && !guarded)
                reason = `${container}[${loop.variable}] can equal ${size}, which is not a valid index for a container of size ${size}.`;
        }
        if (reason)
            diagnostics.push(
                makeRuleDiagnostic(source, "CP002", tokens[index + 1], `Possible out-of-bounds access: ${reason}`),
            );
    }
    return diagnostics;
}

function callArguments(tokens, openIndex) {
    const close = matchingToken(tokens, openIndex, "(", ")");
    if (close < 0) return null;
    const args = [];
    let start = openIndex + 1;
    let round = 0;
    let square = 0;
    let angle = 0;
    for (let index = start; index < close; index++) {
        const value = tokens[index].value;
        if (value === "(") round++;
        else if (value === ")") round--;
        else if (value === "[") square++;
        else if (value === "]") square--;
        else if (value === "<") angle++;
        else if (value === ">") angle--;
        else if (value === ">>") angle -= 2;
        if (value === "," && round === 0 && square === 0 && angle === 0) {
            args.push(tokens.slice(start, index));
            start = index + 1;
        }
    }
    if (start < close || args.length) args.push(tokens.slice(start, close));
    return { args, close };
}

function iteratorContainer(argument, method) {
    for (let index = 0; index + 3 < argument.length; index++) {
        if (
            argument[index].kind === "identifier" &&
            argument[index + 1].value === "." &&
            argument[index + 2].value === method &&
            argument[index + 3].value === "("
        )
            return { name: argument[index].value, token: argument[index] };
    }
    return null;
}

function collectControlRegions(tokens) {
    const regions = [];
    const addBody = (bodyStart) => {
        if (tokens[bodyStart]?.value === "{") {
            const close = matchingToken(tokens, bodyStart, "{", "}");
            if (close >= 0) regions.push({ start: bodyStart, end: close });
            return;
        }
        let end = bodyStart;
        while (end < tokens.length && tokens[end].value !== ";") end++;
        if (end < tokens.length) regions.push({ start: bodyStart, end });
    };
    for (let index = 0; index < tokens.length; index++) {
        if (
            ["if", "for", "while", "switch", "catch"].includes(tokens[index].value) &&
            tokens[index + 1]?.value === "("
        ) {
            const close = matchingToken(tokens, index + 1, "(", ")");
            if (close >= 0) addBody(close + 1);
        } else if (tokens[index].value === "else" || tokens[index].value === "do") {
            addBody(index + 1);
        }
    }
    return regions;
}

function analyzeSortedSearch(source, analysis) {
    const { tokens, tokenScopes } = analysis;
    const sorted = new Set();
    const conditionalSorted = [];
    const diagnostics = [];
    const regions = collectControlRegions(tokens);
    const searches = new Set(["lower_bound", "upper_bound", "binary_search", "equal_range"]);
    const mutations = new Set(["push_back", "emplace_back", "insert", "erase", "clear", "reverse"]);
    const tokenIndices = new Map(tokens.map((token, index) => [token, index]));
    const identity = (occurrence) => {
        const tokenIndex = tokenIndices.get(occurrence.token);
        const scopeId = tokenScopes[tokenIndex];
        const symbol = resolveVisibleSymbol(analysis, occurrence.name, occurrence.token.start, scopeId);
        return symbol ? `symbol:${symbol.offset}` : `name:${scopeId}:${occurrence.name}`;
    };
    const containingRegion = (tokenIndex) =>
        regions
            .filter((region) => tokenIndex > region.start && tokenIndex < region.end)
            .sort((left, right) => left.end - left.start - (right.end - right.start))[0] || null;

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind !== "identifier") continue;

        if (token.value === "ranges" && tokens[index + 1]?.value === "::" && tokens[index + 2]?.value === "sort") {
            const call = callArguments(tokens, index + 3);
            const occurrence =
                call && call.args.length === 1 && call.args[0]?.[0]?.kind === "identifier"
                    ? { name: call.args[0][0].value, token: call.args[0][0] }
                    : null;
            if (occurrence) {
                const key = identity(occurrence);
                const region = containingRegion(index);
                if (region) conditionalSorted.push({ key, offset: token.start, region });
                else sorted.add(key);
            }
            continue;
        }
        if (token.value === "sort" && tokens[index + 1]?.value === "(") {
            const call = callArguments(tokens, index + 1);
            if (!call) continue;
            const beginContainer = iteratorContainer(call.args[0] || [], "begin");
            const endContainer = iteratorContainer(call.args[1] || [], "end");
            if (
                beginContainer &&
                endContainer &&
                identity(beginContainer) === identity(endContainer) &&
                call.args.length === 2
            ) {
                const key = identity(beginContainer);
                const region = containingRegion(index);
                if (region) conditionalSorted.push({ key, offset: token.start, region });
                else sorted.add(key);
            }
            continue;
        }
        if (searches.has(token.value) && tokens[index + 1]?.value === "(") {
            const call = callArguments(tokens, index + 1);
            if (!call) continue;
            const beginContainer = iteratorContainer(call.args[0] || [], "begin");
            const endContainer = iteratorContainer(call.args[1] || [], "end");
            if (beginContainer && endContainer && identity(beginContainer) === identity(endContainer)) {
                const key = identity(beginContainer);
                const localSorted = conditionalSorted.some(
                    (fact) =>
                        fact.key === key &&
                        fact.offset < token.start &&
                        index > fact.region.start &&
                        index < fact.region.end,
                );
                if (sorted.has(key) || localSorted) continue;
                diagnostics.push(
                    makeRuleDiagnostic(
                        source,
                        "CP003",
                        token,
                        `${token.value} is used on '${beginContainer.name}', which is not known to be sorted.`,
                    ),
                );
            }
            continue;
        }

        if (
            tokens[index + 1]?.value === "." &&
            mutations.has(tokens[index + 2]?.value) &&
            tokens[index + 3]?.value === "("
        ) {
            const key = identity({ name: token.value, token });
            sorted.delete(key);
            for (let factIndex = conditionalSorted.length - 1; factIndex >= 0; factIndex--) {
                const fact = conditionalSorted[factIndex];
                if (fact.key === key && index > fact.region.start && index < fact.region.end)
                    conditionalSorted.splice(factIndex, 1);
            }
            continue;
        }
        if (tokens[index + 1]?.value === "[") {
            const key = identity({ name: token.value, token });
            sorted.delete(key);
            for (let factIndex = conditionalSorted.length - 1; factIndex >= 0; factIndex--) {
                const fact = conditionalSorted[factIndex];
                if (fact.key === key && index > fact.region.start && index < fact.region.end)
                    conditionalSorted.splice(factIndex, 1);
            }
        }
        if (token.value === "reverse" && tokens[index + 1]?.value === "(") {
            const call = callArguments(tokens, index + 1);
            const container = call && iteratorContainer(call.args[0] || [], "begin");
            if (container) {
                const key = identity(container);
                sorted.delete(key);
                for (let factIndex = conditionalSorted.length - 1; factIndex >= 0; factIndex--) {
                    const fact = conditionalSorted[factIndex];
                    if (fact.key === key && index > fact.region.start && index < fact.region.end)
                        conditionalSorted.splice(factIndex, 1);
                }
            }
        }
    }
    return diagnostics;
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
            symbol.array ||
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
    diagnostics.push(...analyzeBounds(source, analysis), ...analyzeSortedSearch(source, analysis));
    return { ...analysis, diagnostics };
}

module.exports = { tokenizeCpp, analyzeCpp, analyzeStaticCpp };
