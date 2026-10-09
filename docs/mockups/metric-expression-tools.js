(() => {
  // packages/core/src/formula.ts
  var f = (name, signature, description, min, max, result, args) => ({
    name,
    signature,
    description,
    min,
    max,
    result,
    args
  });
  var FORMULA_FUNCTIONS = [
    ...["LEFT", "RIGHT"].map(
      (n) => f(
        n,
        `${n}(text, count)`,
        "Take Unicode code points from the end indicated.",
        2,
        2,
        "text",
        ["text", "number"]
      )
    ),
    f(
      "SUBSTRING",
      "SUBSTRING(text, start, length)",
      "One-based start; length is optional.",
      2,
      3,
      "text",
      ["text", "number", "number"]
    ),
    f("LENGTH", "LENGTH(text)", "Count Unicode code points.", 1, 1, "number", [
      "text"
    ]),
    ...["LOWER", "UPPER", "TRIM", "LTRIM", "RTRIM"].map(
      (n) => f(
        n,
        `${n}(text)`,
        "Change case or remove surrounding whitespace.",
        1,
        1,
        "text",
        ["text"]
      )
    ),
    f(
      "REPLACE",
      "REPLACE(text, search, replacement)",
      "Replace all literal occurrences.",
      3,
      3,
      "text",
      ["text", "text", "text"]
    ),
    ...["LPAD", "RPAD"].map(
      (n) => f(
        n,
        `${n}(text, length, padding)`,
        "Pad to a code-point length; default padding is a space.",
        2,
        3,
        "text",
        ["text", "number", "text"]
      )
    ),
    f(
      "SPLIT_PART",
      "SPLIT_PART(text, separator, index)",
      "One-based part; missing part returns null.",
      3,
      3,
      "text",
      ["text", "text", "number"]
    ),
    f(
      "CONCAT",
      "CONCAT(text, ...)",
      "Combine text; null propagates.",
      1,
      50,
      "text",
      ["text"]
    ),
    f(
      "CONCAT_WS",
      "CONCAT_WS(separator, text, ...)",
      "Combine text, skipping null arguments.",
      2,
      50,
      "text",
      ["text"]
    ),
    ...["CONTAINS", "STARTS_WITH", "ENDS_WITH"].map(
      (n) => f(
        n,
        `${n}(text, search, ignoreCase)`,
        "Case-sensitive unless the optional third argument is true.",
        2,
        3,
        "bool",
        ["text", "text", "bool"]
      )
    ),
    f(
      "REGEX_TEST",
      "REGEX_TEST(text, pattern, flags)",
      "Test a JavaScript Unicode regex; flags: i, m, s.",
      2,
      3,
      "bool",
      ["text", "text", "text"]
    ),
    f(
      "REGEX_EXTRACT",
      "REGEX_EXTRACT(text, pattern, group, flags)",
      "Extract a capture (default 0: whole match); no match returns null.",
      2,
      4,
      "text",
      ["text", "text", "number", "text"]
    ),
    f(
      "REGEX_REPLACE",
      "REGEX_REPLACE(text, pattern, replacement, flags)",
      "Replace all matches; supports $1 capture references.",
      3,
      4,
      "text",
      ["text", "text", "text", "text"]
    ),
    ...["ABS", "FLOOR", "CEIL", "TRUNC", "SQRT"].map(
      (n) => f(n, `${n}(number)`, "Numeric transformation.", 1, 1, "number", ["number"])
    ),
    f(
      "ROUND",
      "ROUND(number, digits)",
      "Round to decimal places (default 0, range -15 to 15).",
      1,
      2,
      "number",
      ["number"]
    ),
    f(
      "POWER",
      "POWER(base, exponent)",
      "Raise a number to a power.",
      2,
      2,
      "number",
      ["number"]
    ),
    f(
      "CLAMP",
      "CLAMP(number, lower, upper)",
      "Constrain a number to an inclusive range.",
      3,
      3,
      "number",
      ["number"]
    ),
    ...["LEAST", "GREATEST"].map(
      (n) => f(
        n,
        `${n}(number, ...)`,
        "Compare numbers within this row.",
        1,
        50,
        "number",
        ["number"]
      )
    ),
    f(
      "IF",
      "IF(condition, then, otherwise)",
      "Evaluate only the chosen branch; null condition uses otherwise.",
      3,
      3,
      "branch",
      "any"
    ),
    f(
      "IFS",
      "IFS(condition, value, ..., fallback)",
      "First true condition wins; final fallback is required.",
      3,
      49,
      "branch",
      "any"
    ),
    f(
      "SWITCH",
      "SWITCH(value, match, result, ..., fallback)",
      "Match a value to a result; final fallback is required.",
      4,
      50,
      "branch",
      "any"
    ),
    f(
      "COALESCE",
      "COALESCE(value, ...)",
      "First non-null value, evaluated lazily.",
      1,
      50,
      "branch",
      "any"
    ),
    f(
      "NULLIF",
      "NULLIF(value, other)",
      "Return null if the values are equal.",
      2,
      2,
      "branch",
      "any"
    ),
    ...["IS_NULL", "IS_EMPTY"].map(
      (n) => f(
        n,
        `${n}(value)`,
        "Test null, or null/empty text/empty array.",
        1,
        1,
        "bool",
        "any"
      )
    ),
    f(
      "IFERROR",
      "IFERROR(value, fallback)",
      "Use fallback only when evaluating value fails.",
      2,
      2,
      "branch",
      "any"
    ),
    ...[
      ["TO_TEXT", "text"],
      ["TO_NUMBER", "number"],
      ["TO_BOOLEAN", "bool"],
      ["TO_DATETIME", "datetime"]
    ].map(
      ([n, t]) => f(
        n,
        `${n}(value)`,
        "Explicit conversion; invalid input produces a cell error.",
        1,
        1,
        t,
        "any"
      )
    ),
    f(
      "SPLIT",
      "SPLIT(text, separator)",
      "Split text into an array.",
      2,
      2,
      "textarray",
      ["text", "text"]
    ),
    f("JOIN", "JOIN(array, separator)", "Join an array of text.", 2, 2, "text", [
      "textarray",
      "text"
    ]),
    f(
      "ARRAY_LENGTH",
      "ARRAY_LENGTH(array)",
      "Count array elements.",
      1,
      1,
      "number",
      ["textarray"]
    ),
    f(
      "ARRAY_CONTAINS",
      "ARRAY_CONTAINS(array, text)",
      "Case-sensitive array membership.",
      2,
      2,
      "bool",
      ["textarray", "text"]
    ),
    f(
      "ARRAY_GET",
      "ARRAY_GET(array, index)",
      "One-based element; out of range returns null.",
      2,
      2,
      "text",
      ["textarray", "number"]
    ),
    ...["ARRAY_UNIQUE", "ARRAY_SORT"].map(
      (n) => f(
        n,
        `${n}(array)`,
        "Deduplicate or sort text elements by code-point order.",
        1,
        1,
        "textarray",
        ["textarray"]
      )
    ),
    ...["YEAR", "MONTH", "DAY", "HOUR", "WEEKDAY"].map(
      (n) => f(
        n,
        `${n}(datetime)`,
        "UTC date component; weekday is Monday=1 through Sunday=7.",
        1,
        1,
        "number",
        ["datetime"]
      )
    ),
    f(
      "DATE_TRUNC",
      "DATE_TRUNC(unit, datetime)",
      "UTC truncation: year, month, week (Monday), day, hour, minute, second.",
      2,
      2,
      "datetime",
      ["text", "datetime"]
    ),
    f(
      "DATE_ADD",
      "DATE_ADD(unit, amount, datetime)",
      "UTC calendar addition; month/year clamp to the last day.",
      3,
      3,
      "datetime",
      ["text", "number", "datetime"]
    ),
    f(
      "DATE_DIFF",
      "DATE_DIFF(unit, start, end)",
      "Elapsed whole units: week, day, hour, minute, second, millisecond.",
      3,
      3,
      "number",
      ["text", "datetime", "datetime"]
    ),
    f(
      "FORMAT_DATE",
      "FORMAT_DATE(datetime, pattern)",
      "UTC tokens: YYYY MM DD HH mm ss; other text is literal.",
      2,
      2,
      "text",
      ["datetime", "text"]
    )
  ];

  // packages/ui/src/formulaEditorHelpers.ts
  var FORMULA_EDITOR_HELP = "Use [field] references. Ctrl+Space opens suggestions.";
  function formulaContext(text, end = text.length) {
    let quoted = false;
    let fieldStart = -1;
    let escaped = false;
    for (let i = 0; i < end; i++) {
      const c = text[i];
      if (quoted) {
        if (c === "\\") {
          escaped = i + 1 >= end;
          i++;
        } else if (c === '"') quoted = false;
      } else if (fieldStart >= 0) {
        if (c === "]") {
          if (text[i + 1] === "]") i++;
          else fieldStart = -1;
        }
      } else if (c === '"') quoted = true;
      else if (c === "[") fieldStart = i;
    }
    return { quoted, fieldStart, escaped };
  }
  function formulaCompletions(text, start, end, fields, explicit = false) {
    const before = text.slice(0, start);
    const { quoted, fieldStart } = formulaContext(text, start);
    if (quoted || !explicit && start !== end) return null;
    const word = before.match(/\b[A-Za-z_][A-Za-z_0-9]*$/)?.[0] ?? "";
    if (!explicit && fieldStart < 0 && !word) return null;
    const from = start !== end ? start : fieldStart >= 0 ? fieldStart : start - word.length;
    let to = end;
    if (start === end && fieldStart >= 0) {
      for (let i = fieldStart + 1; i < text.length; i++) {
        if (text[i] === "]") {
          if (text[i + 1] === "]") {
            i++;
            continue;
          }
          to = i + 1;
          break;
        }
        if (text[i] === "\n" || text[i] === "[") break;
      }
    } else if (start === end) {
      to += text.slice(end).match(/^[A-Za-z_0-9]*/)?.[0].length ?? 0;
    }
    const prefix = start !== end ? "" : before.slice(from).toLowerCase();
    const options = fields.map((f2) => ({
      label: `[${f2.name.replace(/\]/g, "]]")}]`,
      detail: `${f2.label} \xB7 ${f2.type}`,
      description: f2.name,
      insert: `[${f2.name.replace(/\]/g, "]]")}]`
    }));
    if (fieldStart < 0) {
      options.push(
        ...FORMULA_FUNCTIONS.map((f2) => ({
          label: f2.name,
          detail: f2.signature,
          description: f2.description,
          insert: text[to] === "(" ? f2.name : `${f2.name}()`,
          caretOffset: f2.name.length + 1
        })),
        ...["TRUE", "FALSE", "NULL", "AND", "OR", "NOT", "IN", "BETWEEN"].map(
          (label) => ({
            label,
            detail: "Keyword",
            description: "",
            insert: label
          })
        )
      );
    }
    return {
      from,
      to,
      options: options.filter(
        (option) => option.label.toLowerCase().startsWith(prefix) || fieldStart >= 0 && option.detail.toLowerCase().includes(prefix.slice(1))
      )
    };
  }
  function signatureAt(text) {
    const stack = [];
    let quoted = false, field = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === "\\") i++;
        else if (c === '"') quoted = false;
        continue;
      }
      if (field) {
        if (c === "]") {
          if (text[i + 1] === "]") i++;
          else field = false;
        }
        continue;
      }
      if (c === '"') {
        quoted = true;
        continue;
      }
      if (c === "[") {
        field = true;
        continue;
      }
      if (c === "(")
        stack.push({
          name: text.slice(0, i).match(/([A-Za-z_]+)\s*$/)?.[1]?.toUpperCase() ?? "",
          argument: 1
        });
      else if (c === ")") stack.pop();
      else if (c === "," && stack.length) stack[stack.length - 1].argument++;
    }
    const call = stack[stack.length - 1], spec = FORMULA_FUNCTIONS.find((f2) => f2.name === call?.name);
    return spec && call ? `${spec.signature} \xB7 Argument ${call.argument} \u2014 ${spec.description}` : FORMULA_EDITOR_HELP;
  }

  // docs/mockups/metric-expression-tools.ts
  Object.assign(window, { metricExpressionTools: { formulaCompletions, signatureAt, functions: FORMULA_FUNCTIONS } });
})();
