// Generated from packages/core/src/formula.ts. Do not edit.
(function () { const exports = {};

const originalJoin = Array.prototype.join;
Array.prototype.join = function(separator) {
  const sep = separator === undefined ? "," : String(separator);
  let length = Math.max(0, this.length - 1) * sep.length;
  for (let i = 0; i < this.length; i++) {
    if (this[i] !== null && this[i] !== undefined) length += String(this[i]).length;
    if (length > 100000) throw new Error("Text result exceeds 100,000 characters.");
  }
  return originalJoin.call(this, separator);
};
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FormulaError = exports.FORMULA_FUNCTIONS = void 0;
exports.compileFormula = compileFormula;
exports.formulaRuntime = formulaRuntime;
const f = (name, signature, description, min, max, result, args) => ({
    name,
    signature,
    description,
    min,
    max,
    result,
    args,
});
exports.FORMULA_FUNCTIONS = [
    ...["LEFT", "RIGHT"].map((n) => f(n, `${n}(text, count)`, "Take Unicode code points from the end indicated.", 2, 2, "text", ["text", "number"])),
    f("SUBSTRING", "SUBSTRING(text, start, length)", "One-based start; length is optional.", 2, 3, "text", ["text", "number", "number"]),
    f("LENGTH", "LENGTH(text)", "Count Unicode code points.", 1, 1, "number", [
        "text",
    ]),
    ...["LOWER", "UPPER", "TRIM", "LTRIM", "RTRIM"].map((n) => f(n, `${n}(text)`, "Change case or remove surrounding whitespace.", 1, 1, "text", ["text"])),
    f("REPLACE", "REPLACE(text, search, replacement)", "Replace all literal occurrences.", 3, 3, "text", ["text", "text", "text"]),
    ...["LPAD", "RPAD"].map((n) => f(n, `${n}(text, length, padding)`, "Pad to a code-point length; default padding is a space.", 2, 3, "text", ["text", "number", "text"])),
    f("SPLIT_PART", "SPLIT_PART(text, separator, index)", "One-based part; missing part returns null.", 3, 3, "text", ["text", "text", "number"]),
    f("CONCAT", "CONCAT(text, ...)", "Combine text; null propagates.", 1, 50, "text", ["text"]),
    f("CONCAT_WS", "CONCAT_WS(separator, text, ...)", "Combine text, skipping null arguments.", 2, 50, "text", ["text"]),
    ...["CONTAINS", "STARTS_WITH", "ENDS_WITH"].map((n) => f(n, `${n}(text, search, ignoreCase)`, "Case-sensitive unless the optional third argument is true.", 2, 3, "bool", ["text", "text", "bool"])),
    f("REGEX_TEST", "REGEX_TEST(text, pattern, flags)", "Test a JavaScript Unicode regex; flags: i, m, s.", 2, 3, "bool", ["text", "text", "text"]),
    f("REGEX_EXTRACT", "REGEX_EXTRACT(text, pattern, group, flags)", "Extract a capture (default 0: whole match); no match returns null.", 2, 4, "text", ["text", "text", "number", "text"]),
    f("REGEX_REPLACE", "REGEX_REPLACE(text, pattern, replacement, flags)", "Replace all matches; supports $1 capture references.", 3, 4, "text", ["text", "text", "text", "text"]),
    ...["ABS", "FLOOR", "CEIL", "TRUNC", "SQRT"].map((n) => f(n, `${n}(number)`, "Numeric transformation.", 1, 1, "number", ["number"])),
    f("ROUND", "ROUND(number, digits)", "Round to decimal places (default 0, range -15 to 15).", 1, 2, "number", ["number"]),
    f("POWER", "POWER(base, exponent)", "Raise a number to a power.", 2, 2, "number", ["number"]),
    f("CLAMP", "CLAMP(number, lower, upper)", "Constrain a number to an inclusive range.", 3, 3, "number", ["number"]),
    ...["LEAST", "GREATEST"].map((n) => f(n, `${n}(number, ...)`, "Compare numbers within this row.", 1, 50, "number", ["number"])),
    f("IF", "IF(condition, then, otherwise)", "Evaluate only the chosen branch; null condition uses otherwise.", 3, 3, "branch", "any"),
    f("IFS", "IFS(condition, value, ..., fallback)", "First true condition wins; final fallback is required.", 3, 49, "branch", "any"),
    f("SWITCH", "SWITCH(value, match, result, ..., fallback)", "Match a value to a result; final fallback is required.", 4, 50, "branch", "any"),
    f("COALESCE", "COALESCE(value, ...)", "First non-null value, evaluated lazily.", 1, 50, "branch", "any"),
    f("NULLIF", "NULLIF(value, other)", "Return null if the values are equal.", 2, 2, "branch", "any"),
    ...["IS_NULL", "IS_EMPTY"].map((n) => f(n, `${n}(value)`, "Test null, or null/empty text/empty array.", 1, 1, "bool", "any")),
    f("IFERROR", "IFERROR(value, fallback)", "Use fallback only when evaluating value fails.", 2, 2, "branch", "any"),
    ...[
        ["TO_TEXT", "text"],
        ["TO_NUMBER", "number"],
        ["TO_BOOLEAN", "bool"],
        ["TO_DATETIME", "datetime"],
    ].map(([n, t]) => f(n, `${n}(value)`, "Explicit conversion; invalid input produces a cell error.", 1, 1, t, "any")),
    f("SPLIT", "SPLIT(text, separator)", "Split text into an array.", 2, 2, "textarray", ["text", "text"]),
    f("JOIN", "JOIN(array, separator)", "Join an array of text.", 2, 2, "text", [
        "textarray",
        "text",
    ]),
    f("ARRAY_LENGTH", "ARRAY_LENGTH(array)", "Count array elements.", 1, 1, "number", ["textarray"]),
    f("ARRAY_CONTAINS", "ARRAY_CONTAINS(array, text)", "Case-sensitive array membership.", 2, 2, "bool", ["textarray", "text"]),
    f("ARRAY_GET", "ARRAY_GET(array, index)", "One-based element; out of range returns null.", 2, 2, "text", ["textarray", "number"]),
    ...["ARRAY_UNIQUE", "ARRAY_SORT"].map((n) => f(n, `${n}(array)`, "Deduplicate or sort text elements by code-point order.", 1, 1, "textarray", ["textarray"])),
    ...["YEAR", "MONTH", "DAY", "HOUR", "WEEKDAY"].map((n) => f(n, `${n}(datetime)`, "UTC date component; weekday is Monday=1 through Sunday=7.", 1, 1, "number", ["datetime"])),
    f("DATE_TRUNC", "DATE_TRUNC(unit, datetime)", "UTC truncation: year, month, week (Monday), day, hour, minute, second.", 2, 2, "datetime", ["text", "datetime"]),
    f("DATE_ADD", "DATE_ADD(unit, amount, datetime)", "UTC calendar addition; month/year clamp to the last day.", 3, 3, "datetime", ["text", "number", "datetime"]),
    f("DATE_DIFF", "DATE_DIFF(unit, start, end)", "Elapsed whole units: week, day, hour, minute, second, millisecond.", 3, 3, "number", ["text", "datetime", "datetime"]),
    f("FORMAT_DATE", "FORMAT_DATE(datetime, pattern)", "UTC tokens: YYYY MM DD HH mm ss; other text is literal.", 2, 2, "text", ["datetime", "text"]),
];
class FormulaError extends Error {
    constructor(message, from = 0, to = from + 1) {
        super(message);
        this.from = from;
        this.to = to;
    }
}
exports.FormulaError = FormulaError;
function compileFormula(source, fields, resolve) {
    if (!source.trim() || source.length > 10000)
        throw new FormulaError("Formula must contain 1–10,000 characters.");
    const tokens = [];
    let pos = 0;
    while (pos < source.length) {
        if (/\s/.test(source[pos])) {
            pos++;
            continue;
        }
        const from = pos;
        let match;
        if (source[pos] === "[") {
            pos++;
            let text = "";
            let closed = false;
            while (pos < source.length) {
                if (source[pos] === "]") {
                    if (source[pos + 1] === "]") {
                        text += "]";
                        pos += 2;
                    }
                    else {
                        pos++;
                        closed = true;
                        break;
                    }
                }
                else
                    text += source[pos++];
            }
            if (!closed)
                throw new FormulaError("Unclosed field reference.", from, pos);
            tokens.push({ kind: "field", text, from, to: pos });
        }
        else if (source[pos] === '"') {
            pos++;
            while (pos < source.length && source[pos] !== '"') {
                if (source[pos] === "\\")
                    pos++;
                pos++;
            }
            pos++;
            try {
                tokens.push({
                    kind: "string",
                    text: JSON.parse(source.slice(from, pos)),
                    from,
                    to: pos,
                });
            }
            catch {
                throw new FormulaError("Invalid JSON string literal.", from, pos);
            }
        }
        else if ((match = source
            .slice(pos)
            .match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/))) {
            pos += match[0].length;
            tokens.push({ kind: "number", text: match[0], from, to: pos });
        }
        else if ((match = source.slice(pos).match(/^[a-zA-Z_][a-zA-Z_0-9]*/))) {
            pos += match[0].length;
            tokens.push({
                kind: "word",
                text: match[0].toUpperCase(),
                from,
                to: pos,
            });
        }
        else if ((match = source.slice(pos).match(/^(>=|<=|!=|<>|[=<>+*/%(),-])/))) {
            pos += match[0].length;
            tokens.push({ kind: "op", text: match[0], from, to: pos });
        }
        else
            throw new FormulaError(`Unexpected character ${source[pos]}.`, from);
        if (tokens.length > 2000)
            throw new FormulaError("Formula is too complex.", from);
    }
    tokens.push({ kind: "end", text: "", from: pos, to: pos });
    let i = 0, depth = 0;
    const peek = () => tokens[i];
    const take = () => tokens[i++];
    const expect = (s) => {
        if (peek().text !== s)
            throw new FormulaError(`Expected ${s}.`, peek().from, peek().to);
        return take();
    };
    const call = (name, args, from, to) => ({ kind: "call", name, args, from, to });
    const priority = {
        OR: 1,
        AND: 2,
        "=": 3,
        "!=": 3,
        "<>": 3,
        "<": 3,
        ">": 3,
        "<=": 3,
        ">=": 3,
        IN: 3,
        BETWEEN: 3,
        "+": 4,
        "-": 4,
        "*": 5,
        "/": 5,
        "%": 5,
    };
    function expression(min = 0) {
        if (++depth > 50)
            throw new FormulaError("Maximum nesting depth is 50.", peek().from);
        const t = take();
        let node;
        if (t.kind === "number") {
            if (!Number.isFinite(Number(t.text)))
                throw new FormulaError("Number must be finite.", t.from, t.to);
            node = { kind: "literal", value: Number(t.text), from: t.from, to: t.to };
        }
        else if (t.kind === "string")
            node = { kind: "literal", value: t.text, from: t.from, to: t.to };
        else if (t.kind === "field")
            node = { kind: "field", name: t.text, from: t.from, to: t.to };
        else if (["TRUE", "FALSE", "NULL"].includes(t.text))
            node = {
                kind: "literal",
                value: t.text === "NULL" ? null : t.text === "TRUE",
                from: t.from,
                to: t.to,
            };
        else if (t.text === "(") {
            node = expression();
            expect(")");
        }
        else if (["NOT", "-", "+"].includes(t.text)) {
            const arg = expression(t.text === "NOT" ? 3 : 6);
            node = call(`unary:${t.text}`, [arg], t.from, arg.to);
        }
        else if (t.kind === "word") {
            expect("(");
            const args = [];
            if (peek().text !== ")") {
                do {
                    args.push(expression());
                    if (peek().text !== ",")
                        break;
                    take();
                } while (true);
            }
            node = call(t.text, args, t.from, expect(")").to);
        }
        else
            throw new FormulaError("Expected a value, field, or function.", t.from, t.to);
        while (peek().kind !== "end" && (priority[peek().text] ?? -1) >= min) {
            const op = take();
            const p = priority[op.text];
            if (op.text === "IN") {
                expect("(");
                const args = [node];
                do {
                    args.push(expression());
                    if (peek().text !== ",")
                        break;
                    take();
                } while (true);
                node = call("op:IN", args, node.from, expect(")").to);
            }
            else if (op.text === "BETWEEN") {
                const lo = expression(p + 1);
                expect("AND");
                const hi = expression(p + 1);
                node = call("op:BETWEEN", [node, lo, hi], node.from, hi.to);
            }
            else {
                const right = expression(p + 1);
                node = call(`op:${op.text}`, [node, right], node.from, right.to);
            }
        }
        depth--;
        return node;
    }
    const ast = expression();
    if (peek().kind !== "end")
        throw new FormulaError("Unexpected token.", peek().from, peek().to);
    const deps = new Set();
    const byName = new Map(fields.map((v) => [v.name, v.type]));
    const same = (ts, n) => {
        const real = [...new Set(ts.filter((t) => t !== "null"))];
        if (real.length > 1)
            throw new FormulaError("Values must have compatible types; use an explicit conversion.", n.from, n.to);
        return real[0] ?? "null";
    };
    function check(n, level = 0) {
        if (level > 50)
            throw new FormulaError("Maximum nesting depth is 50.", n.from, n.to);
        if (n.kind === "literal")
            return n.value === null
                ? "null"
                : typeof n.value === "boolean"
                    ? "bool"
                    : typeof n.value === "number"
                        ? "number"
                        : "text";
        if (n.kind === "field") {
            const t = byName.get(n.name);
            if (!t) {
                const nested = resolve?.(n.name);
                if (nested) {
                    Object.assign(n, nested.ast);
                    nested.dependencies.forEach((d) => deps.add(d));
                    return nested.type;
                }
                throw new FormulaError(`Unknown or unavailable field: ${n.name}`, n.from, n.to);
            }
            deps.add(n.name);
            n.valueType = t === "enum" ? "text" : t;
            return n.valueType;
        }
        const ts = n.args.map((a) => check(a, level + 1));
        const need = (index, t) => {
            if (ts[index] !== undefined && ts[index] !== "null" && ts[index] !== t)
                throw new FormulaError(`Expected ${t}, received ${ts[index]}.`, n.args[index].from, n.args[index].to);
        };
        if (n.name.startsWith("op:") || n.name.startsWith("unary:")) {
            const op = n.name.split(":")[1];
            if (["AND", "OR", "NOT"].includes(op)) {
                ts.forEach((_, j) => need(j, "bool"));
                return "bool";
            }
            if (["+", "-", "*", "/", "%"].includes(op)) {
                ts.forEach((_, j) => need(j, "number"));
                return "number";
            }
            same(ts, n);
            return "bool";
        }
        const spec = exports.FORMULA_FUNCTIONS.find((v) => v.name === n.name);
        if (!spec)
            throw new FormulaError(`Unknown function: ${n.name}`, n.from, n.to);
        if (ts.length < spec.min || ts.length > spec.max)
            throw new FormulaError(`Use ${spec.signature}.`, n.from, n.to);
        if (spec.args !== "any") {
            const args = spec.args;
            ts.forEach((_, j) => need(j, args[Math.min(j, args.length - 1)]));
        }
        if (n.name === "IF") {
            need(0, "bool");
            return same(ts.slice(1), n);
        }
        if (n.name === "IFS") {
            if (ts.length % 2 !== 1)
                throw new FormulaError("IFS requires condition/value pairs and a fallback.", n.from, n.to);
            const branches = [];
            ts.forEach((t, j) => {
                if (j === ts.length - 1 || j % 2 === 1)
                    branches.push(t);
                else
                    need(j, "bool");
            });
            return same(branches, n);
        }
        if (n.name === "SWITCH") {
            if (ts.length % 2 !== 0)
                throw new FormulaError("SWITCH requires match/result pairs and a fallback.", n.from, n.to);
            const branches = [];
            for (let j = 1; j < ts.length - 1; j += 2) {
                same([ts[0], ts[j]], n);
                branches.push(ts[j + 1]);
            }
            branches.push(ts[ts.length - 1]);
            return same(branches, n);
        }
        if (n.name.startsWith("REGEX_")) {
            const pattern = n.args[1];
            const flags = n.args[n.name === "REGEX_TEST" ? 2 : 3];
            if (pattern?.kind === "literal" && typeof pattern.value === "string") {
                if (pattern.value.length > 2000)
                    throw new FormulaError("Regex pattern exceeds 2,000 characters.", pattern.from, pattern.to);
                if (!flags ||
                    (flags.kind === "literal" && typeof flags.value === "string")) {
                    const value = flags?.value ?? "";
                    if (!/^(?!.*(.).*\1)[ims]*$/.test(String(value)))
                        throw new FormulaError("Regex flags must be unique i, m, or s.", n.from, n.to);
                    try {
                        new RegExp(pattern.value, `${value}u`);
                    }
                    catch {
                        throw new FormulaError("Invalid regex pattern.", pattern.from, pattern.to);
                    }
                }
            }
        }
        if (spec.result === "branch")
            return same(ts, n);
        return spec.result;
    }
    const type = check(ast);
    return { ast, dependencies: [...deps].sort(), type };
}
/** Self-contained runtime: serialized into the browser worker, never user code. */
function formulaRuntime(ast, inputs) {
    const fail = (s) => {
        throw new Error(s);
    };
    const num = (v) => typeof v === "number" && Number.isFinite(v)
        ? v
        : fail("Expected a finite number.");
    const str = (v) => typeof v === "string" ? v : fail("Expected text.");
    const arr = (v) => Array.isArray(v) && v.every((x) => typeof x === "string")
        ? v
        : fail("Expected a text array.");
    const integer = (v, min = 0, max = 100000) => {
        const n = num(v);
        return Number.isInteger(n) && n >= min && n <= max
            ? n
            : fail(`Expected an integer between ${min} and ${max}.`);
    };
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const date = (v) => {
        const s = str(v);
        if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(s))
            fail("Expected an ISO date or timestamp with timezone.");
        const d = new Date(s);
        const day = Number(s.slice(8, 10)), month = Number(s.slice(5, 7));
        if (!Number.isFinite(d.getTime()) ||
            month < 1 ||
            month > 12 ||
            day < 1 ||
            day > new Date(Date.UTC(Number(s.slice(0, 4)), month, 0)).getUTCDate())
            fail("Invalid date.");
        return d;
    };
    const bound = (v) => {
        if (v !== null &&
            typeof v !== "number" &&
            typeof v !== "string" &&
            typeof v !== "boolean" &&
            !Array.isArray(v))
            fail("Unsupported input value type.");
        if (Array.isArray(v) && !v.every((x) => typeof x === "string"))
            fail("Expected a text array.");
        if (typeof v === "number" && !Number.isFinite(v))
            fail("Result is not finite.");
        if (typeof v === "string" && v.length > 100000)
            fail("Text result exceeds 100,000 characters.");
        if (Array.isArray(v) &&
            (v.length > 10000 || v.reduce((s, x) => s + x.length, 0) > 100000))
            fail("Array result is too large.");
        return v;
    };
    let inspection;
    let budget = 5000;
    function run(n) {
        if (--budget < 0)
            fail("Formula operation limit exceeded.");
        if (n.kind === "literal")
            return n.value;
        if (n.kind === "field") {
            if (!Object.prototype.hasOwnProperty.call(inputs, n.name))
                return null;
            const v = bound(inputs[n.name] ?? null);
            if (v === null)
                return null;
            if (n.valueType === "number")
                return num(v);
            if (n.valueType === "bool" && typeof v !== "boolean")
                fail("Expected a boolean.");
            if (n.valueType === "datetime")
                return date(v).toISOString();
            if (n.valueType === "text")
                return str(v);
            if (n.valueType === "textarray")
                return arr(v);
            return v;
        }
        const name = n.name;
        const args = n.args;
        if (name === "IF")
            return run(run(args[0]) === true ? args[1] : args[2]);
        if (name === "IFS") {
            for (let j = 0; j < args.length - 1; j += 2)
                if (run(args[j]) === true)
                    return run(args[j + 1]);
            return run(args[args.length - 1]);
        }
        if (name === "SWITCH") {
            const v = run(args[0]);
            for (let j = 1; j < args.length - 1; j += 2)
                if (equal(v, run(args[j])))
                    return run(args[j + 1]);
            return run(args[args.length - 1]);
        }
        if (name === "COALESCE") {
            for (const arg of args) {
                const v = run(arg);
                if (v !== null)
                    return v;
            }
            return null;
        }
        if (name === "IFERROR") {
            try {
                return run(args[0]);
            }
            catch {
                return run(args[1]);
            }
        }
        if (name === "op:AND" || name === "op:OR") {
            const a = run(args[0]);
            if (name === "op:AND" && a === false)
                return false;
            if (name === "op:OR" && a === true)
                return true;
            const b = run(args[1]);
            return name === "op:AND"
                ? b === false
                    ? false
                    : a === null || b === null
                        ? null
                        : true
                : b === true
                    ? true
                    : a === null || b === null
                        ? null
                        : false;
        }
        const vs = args.map(run);
        const a = vs[0] ?? null, b = vs[1] ?? null, c = vs[2] ?? null;
        if (name === "IS_NULL")
            return a === null;
        if (name === "IS_EMPTY")
            return a === null || a === "" || (Array.isArray(a) && a.length === 0);
        if (name === "NULLIF")
            return equal(a, b) ? null : a;
        if (name === "CONCAT_WS")
            return a === null
                ? null
                : bound(vs
                    .slice(1)
                    .filter((v) => v !== null)
                    .map(str)
                    .join(str(a)));
        if (name === "op:IN") {
            if (a === null)
                return null;
            if (vs.slice(1).some((v) => v !== null && equal(a, v)))
                return true;
            return vs.slice(1).includes(null) ? null : false;
        }
        if (vs.some((v) => v === null))
            return null;
        let out;
        switch (name) {
            case "unary:NOT":
                out = !a;
                break;
            case "unary:-":
                out = -num(a);
                break;
            case "unary:+":
                out = num(a);
                break;
            case "op:+":
                out = num(a) + num(b);
                break;
            case "op:-":
                out = num(a) - num(b);
                break;
            case "op:*":
                out = num(a) * num(b);
                break;
            case "op:/":
            case "op:%":
                if (num(b) === 0)
                    fail("Division by zero.");
                out = name === "op:/" ? num(a) / num(b) : num(a) % num(b);
                break;
            case "op:=":
                out = equal(a, b);
                break;
            case "op:!=":
            case "op:<>":
                out = !equal(a, b);
                break;
            case "op:<":
                out = a < b;
                break;
            case "op:>":
                out = a > b;
                break;
            case "op:<=":
                out = a <= b;
                break;
            case "op:>=":
                out = a >= b;
                break;
            case "op:BETWEEN":
                out = a >= b && a <= c;
                break;
            case "LEFT":
                out = Array.from(str(a)).slice(0, integer(b)).join("");
                break;
            case "RIGHT": {
                const n = integer(b);
                out = n ? Array.from(str(a)).slice(-n).join("") : "";
                break;
            }
            case "SUBSTRING": {
                const start = integer(b, 1) - 1;
                out = Array.from(str(a))
                    .slice(start, vs.length > 2 ? start + integer(c) : undefined)
                    .join("");
                break;
            }
            case "LENGTH":
                out = Array.from(str(a)).length;
                break;
            case "LOWER":
                out = str(a).toLowerCase();
                break;
            case "UPPER":
                out = str(a).toUpperCase();
                break;
            case "TRIM":
                out = str(a).trim();
                break;
            case "LTRIM":
                out = str(a).trimStart();
                break;
            case "RTRIM":
                out = str(a).trimEnd();
                break;
            case "REPLACE":
                if (b === "")
                    fail("Search text must not be empty.");
                const parts = str(a).split(str(b));
                if (parts.length * str(c).length + str(a).length > 200000)
                    fail("Replacement result is too large.");
                out = parts.join(str(c));
                break;
            case "LPAD":
            case "RPAD": {
                const chars = Array.from(str(a)), len = integer(b), pad = Array.from(vs.length > 2 ? str(c) : " ");
                if (!pad.length)
                    fail("Padding must not be empty.");
                const fill = Array.from({ length: Math.max(0, len - chars.length) }, (_, i) => pad[i % pad.length]).join("");
                out =
                    (name === "LPAD" ? fill : "") +
                        chars.slice(0, len).join("") +
                        (name === "RPAD" ? fill : "");
                break;
            }
            case "SPLIT_PART":
                out = str(a).split(str(b))[integer(c, 1) - 1] ?? null;
                break;
            case "CONCAT":
                out = vs.map(str).join("");
                break;
            case "CONTAINS":
            case "STARTS_WITH":
            case "ENDS_WITH": {
                const s = c === true ? str(a).toLowerCase() : str(a), t = c === true ? str(b).toLowerCase() : str(b);
                out =
                    name === "CONTAINS"
                        ? s.includes(t)
                        : name === "STARTS_WITH"
                            ? s.startsWith(t)
                            : s.endsWith(t);
                break;
            }
            case "REGEX_TEST":
            case "REGEX_EXTRACT":
            case "REGEX_REPLACE": {
                const flags = vs[name === "REGEX_TEST" ? 2 : 3] ?? "";
                if (!/^(?!.*(.).*\1)[ims]*$/.test(str(flags)))
                    fail("Regex flags must be unique i, m, or s.");
                if (str(b).length > 2000)
                    fail("Regex pattern exceeds 2,000 characters.");
                const re = new RegExp(str(b), `${flags}u${name === "REGEX_REPLACE" ? "g" : ""}`);
                if (name === "REGEX_TEST")
                    out = re.test(str(a));
                else if (name === "REGEX_REPLACE") {
                    let produced = 0;
                    out = str(a).replace(re, (...captures) => {
                        const replacement = str(c).replace(/\$(\$|[0-9]{1,2}|&|`|')/g, (_token, key) => {
                            if (key === "$")
                                return "$";
                            if (key === "&")
                                return String(captures[0]);
                            if (key === "`" || key === "'")
                                return fail("Regex replacement supports $$, $&, and numbered captures only.");
                            const extra = typeof captures[captures.length - 1] === "object" ? 3 : 2;
                            const i = Number(key);
                            return i > 0 && i < captures.length - extra
                                ? String(captures[i] ?? "")
                                : fail("Invalid replacement capture.");
                        });
                        produced += replacement.length;
                        if (produced > 100000)
                            fail("Replacement result is too large.");
                        return replacement;
                    });
                }
                else {
                    const match = re.exec(str(a));
                    const group = vs.length > 2 ? integer(c, 0, 100) : 0;
                    out = match?.[group] ?? null;
                    if (match)
                        inspection = {
                            input: str(a),
                            start: match.index,
                            end: match.index + match[0].length,
                            groups: Array.from(match, (v) => v ?? null),
                        };
                }
                break;
            }
            case "ABS":
                out = Math.abs(num(a));
                break;
            case "FLOOR":
                out = Math.floor(num(a));
                break;
            case "CEIL":
                out = Math.ceil(num(a));
                break;
            case "TRUNC":
                out = Math.trunc(num(a));
                break;
            case "SQRT":
                out = Math.sqrt(num(a));
                break;
            case "ROUND": {
                const scale = 10 ** (vs.length > 1 ? integer(b, -15, 15) : 0);
                out = Math.round(num(a) * scale) / scale;
                break;
            }
            case "POWER":
                out = Math.pow(num(a), num(b));
                break;
            case "CLAMP":
                if (num(b) > num(c))
                    fail("Lower bound exceeds upper bound.");
                out = Math.max(num(b), Math.min(num(c), num(a)));
                break;
            case "LEAST":
                out = Math.min(...vs.map(num));
                break;
            case "GREATEST":
                out = Math.max(...vs.map(num));
                break;
            case "TO_TEXT":
                out = Array.isArray(a) ? JSON.stringify(a) : String(a);
                break;
            case "TO_NUMBER":
                if (typeof a !== "number" &&
                    (typeof a !== "string" ||
                        !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(a.trim())))
                    fail("Cannot convert to number.");
                out = Number(a);
                break;
            case "TO_BOOLEAN":
                if (a === true || a === false)
                    out = a;
                else if (a === "true" || a === 1)
                    out = true;
                else if (a === "false" || a === 0)
                    out = false;
                else
                    return fail("Cannot convert to boolean.");
                break;
            case "TO_DATETIME":
                out = date(a).toISOString();
                break;
            case "SPLIT":
                out = str(a).split(str(b));
                break;
            case "JOIN":
                out = arr(a).join(str(b));
                break;
            case "ARRAY_LENGTH":
                out = arr(a).length;
                break;
            case "ARRAY_CONTAINS":
                out = arr(a).includes(str(b));
                break;
            case "ARRAY_GET":
                out = arr(a)[integer(b, 1) - 1] ?? null;
                break;
            case "ARRAY_UNIQUE":
                out = [...new Set(arr(a))];
                break;
            case "ARRAY_SORT":
                out = [...arr(a)].sort((left, right) => {
                    const l = Array.from(left), r = Array.from(right);
                    for (let i = 0; i < Math.min(l.length, r.length); i++) {
                        const delta = l[i].codePointAt(0) - r[i].codePointAt(0);
                        if (delta)
                            return delta;
                    }
                    return l.length - r.length;
                });
                break;
            case "YEAR":
                out = date(a).getUTCFullYear();
                break;
            case "MONTH":
                out = date(a).getUTCMonth() + 1;
                break;
            case "DAY":
                out = date(a).getUTCDate();
                break;
            case "HOUR":
                out = date(a).getUTCHours();
                break;
            case "WEEKDAY":
                out = ((date(a).getUTCDay() + 6) % 7) + 1;
                break;
            case "DATE_TRUNC": {
                const d = date(b), unit = str(a).toLowerCase();
                if (![
                    "year",
                    "month",
                    "week",
                    "day",
                    "hour",
                    "minute",
                    "second",
                ].includes(unit))
                    fail("Unsupported date unit.");
                d.setUTCMilliseconds(0);
                if (unit !== "second")
                    d.setUTCSeconds(0);
                if (!["second", "minute"].includes(unit))
                    d.setUTCMinutes(0);
                if (["year", "month", "week", "day"].includes(unit))
                    d.setUTCHours(0);
                if (unit === "week")
                    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
                if (unit === "year" || unit === "month")
                    d.setUTCDate(1);
                if (unit === "year")
                    d.setUTCMonth(0);
                out = d.toISOString();
                break;
            }
            case "DATE_ADD": {
                const d = date(c), unit = str(a).toLowerCase(), amount = integer(b, -100000, 100000);
                if (unit === "year" || unit === "month") {
                    const day = d.getUTCDate();
                    d.setUTCDate(1);
                    d.setUTCMonth(d.getUTCMonth() + amount * (unit === "year" ? 12 : 1));
                    const last = new Date(d.getTime());
                    last.setUTCMonth(last.getUTCMonth() + 1, 0);
                    d.setUTCDate(Math.min(day, last.getUTCDate()));
                }
                else {
                    const units = {
                        week: 604800000,
                        day: 86400000,
                        hour: 3600000,
                        minute: 60000,
                        second: 1000,
                        millisecond: 1,
                    };
                    const ms = units[unit];
                    if (!ms)
                        fail("Unsupported date unit.");
                    d.setTime(d.getTime() + amount * ms);
                }
                out = d.toISOString();
                break;
            }
            case "DATE_DIFF": {
                const units = {
                    week: 604800000,
                    day: 86400000,
                    hour: 3600000,
                    minute: 60000,
                    second: 1000,
                    millisecond: 1,
                };
                const ms = units[str(a).toLowerCase()];
                if (!ms)
                    fail("Unsupported elapsed date unit.");
                out = Math.trunc((date(c).getTime() - date(b).getTime()) / ms);
                break;
            }
            case "FORMAT_DATE": {
                const d = date(a), pad = (n) => String(n).padStart(2, "0"), parts = {
                    YYYY: String(d.getUTCFullYear()).padStart(4, "0"),
                    MM: pad(d.getUTCMonth() + 1),
                    DD: pad(d.getUTCDate()),
                    HH: pad(d.getUTCHours()),
                    mm: pad(d.getUTCMinutes()),
                    ss: pad(d.getUTCSeconds()),
                };
                out = str(b).replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => parts[t]);
                break;
            }
            default:
                return fail(`Unknown operation: ${name}`);
        }
        return bound(out);
    }
    try {
        const value = run(ast);
        return inspection ? { value, regex: inspection } : { value };
    }
    catch (e) {
        return {
            value: null,
            error: e instanceof Error ? e.message : "Formula evaluation failed.",
        };
    }
}

globalThis.qtFormula = function (raw) {
  try {
    const request = JSON.parse(raw);
    if (request.action === "compile") {
      const defs = request.definitions || [];
      const stack = new Set(request.editingID ? [request.editingID] : []);
      let expanded = 0;
      const resolve = name => {
        if (!name.startsWith("@computed/")) return undefined;
        const id = name.slice(10), def = defs.find(d => d.id === id);
        if (!def) throw new Error("Computed column unavailable: " + id);
        if (stack.has(id)) throw new Error("Circular computed-column reference: " + def.label);
        if (stack.size >= 20 || ++expanded > 100) throw new Error("Computed dependency graph is too large.");
        stack.add(id);
        try { return exports.compileFormula(def.expression.source, request.fields, resolve); }
        finally { stack.delete(id); }
      };
      const plan = exports.compileFormula(request.source, request.fields, resolve);
      let nodes = 0;
      const inspect = (node, depth = 0) => {
        if (++nodes > 5000 || depth > 50) throw new Error("Expanded formula exceeds native execution limits.");
        if (node.kind === "call") {
          if (node.name.startsWith("REGEX_")) throw new Error("Regex formulas require an interruptible runtime and are not supported by the native evaluator.");
          node.args.forEach(child => inspect(child, depth + 1));
        }
      };
      inspect(plan.ast);
      return JSON.stringify({ result: plan });
    }
    return JSON.stringify({ result: exports.formulaRuntime(request.plan.ast, request.row) });
  } catch (error) {
    return JSON.stringify({ error: String(error.message || error) });
  }
};

})();
