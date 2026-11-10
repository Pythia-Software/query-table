package querytable

import (
	"strconv"
	"strings"
)

// Text and array row functions. Each lowering matches the browser formula
// runtime (packages/core/src/formula.ts) exactly on valid UTF-8 operands:
//
//   - LENGTH counts Unicode code points (Array.from(text).length).
//   - TRIM, LTRIM and RTRIM remove the ECMAScript white space and line
//     terminator set (jsWhitespace), not the engine's own notion of space.
//   - CONTAINS, STARTS_WITH and ENDS_WITH are exact, case-sensitive substring
//     tests; an empty search text matches.
//
// LOWER, UPPER and the ignoreCase argument are the exception: they use each
// engine's case mapping and differ from JavaScript on a few characters
// (caseMapped).
//   - SPLIT(text, separator) has the count of text.split(separator): an
//     empty separator splits UTF-16 code units, an empty text gives one
//     element. More than 10,000 elements is the array_range error.
//
// A text array is not a SQL value here: it is represented by its element
// count, and ARRAY_LENGTH is its only consumer. Every other use of an array
// is refused with unsupported_type. NULL arguments return NULL.

// maxFormulaArrayElements is the browser's array result bound.
const maxFormulaArrayElements = 10000

func textArrayRefusal() error {
	return diagnostic(ErrorCodeUnsupportedType, "text arrays are supported only as ARRAY_LENGTH(SPLIT(text, separator)) in the server profile")
}

// text casts a PostgreSQL operand whose type may be unknown (a bare NULL).
func (b *planBuilder) text(v ValueSQL) string {
	if b.sqlite {
		return v.Value
	}
	return "(" + v.Value + ")::text"
}

// textOperation returns the value SQL, error SQL and type of a text function.
// e is the COALESCE of the argument errors.
func (b *planBuilder) textOperation(op string, a []ValueSQL, e string) (string, string, string, error) {
	for i, x := range a {
		want := "text"
		if op == "ARRAY_LENGTH" {
			want = "textarray"
		} else if i == 2 {
			want = "bool" // ignoreCase
		}
		if err := requireType(x, want); err != nil {
			return "", "", "", err
		}
	}
	x := b.text(a[0])
	y := ""
	if len(a) > 1 {
		y = b.text(a[1])
	}
	switch op {
	case "LENGTH":
		if b.sqlite {
			// SQLite's length() stops at an embedded NUL; text containing one
			// is counted by a registered function.
			return "CASE WHEN instr(CAST(" + x + " AS BLOB),x'00')>0 THEN qt_v2_length(CAST(" + x + " AS BLOB)) ELSE length(" + x + ") END", e, "number", nil
		}
		return "(char_length(" + x + "))::double precision", e, "number", nil
	case "LOWER", "UPPER":
		return b.caseMapped(op, x), e, "text", nil
	case "TRIM", "LTRIM", "RTRIM":
		fn := strings.ToLower(op)
		if op == "TRIM" && !b.sqlite {
			fn = "btrim"
		}
		return fn + "(" + x + "," + b.param(jsWhitespace, "text") + ")" + b.collation(), e, "text", nil
	case "CONTAINS", "STARTS_WITH", "ENDS_WITH":
		exact := b.textMatch(op, x, y)
		if len(a) < 3 {
			return exact, e, "bool", nil
		}
		// ignoreCase lower-cases both sides, as the browser does; a NULL flag
		// gives NULL.
		folded := b.textMatch(op, b.caseMapped("LOWER", x), b.caseMapped("LOWER", y))
		return "CASE WHEN " + a[2].Value + " IS NULL THEN NULL WHEN " + a[2].Value + " THEN " + folded + " ELSE " + exact + " END", e, "bool", nil
	case "SPLIT":
		var count ValueSQL
		if b.sqlite {
			count = b.emit("qt_v2_split_count("+sqliteBytes(x)+","+sqliteBytes(y)+")", e, "number")
		} else {
			// Non-overlapping occurrences, left to right, as String.split.
			// An empty separator counts UTF-16 code units: one per code point
			// plus one per supplementary code point.
			supplementary := "char_length(regexp_replace(" + x + "," + b.param(`[^\U00010000-\U0010FFFF]`, "text") + ",'','g'))"
			count = b.emit("(CASE WHEN "+y+"='' THEN char_length("+x+")+"+supplementary+" ELSE (char_length("+x+")-char_length(replace("+x+","+y+",'')))/char_length("+y+")+1 END)::double precision", e, "number")
		}
		return count.Value, "COALESCE(" + count.Error + ",CASE WHEN " + count.Value + ">" + strconv.Itoa(maxFormulaArrayElements) + " THEN " + b.errorLiteral("array_range") + " END)", "textarray", nil
	case "ARRAY_LENGTH":
		return a[0].Value, e, "number", nil
	}
	return "", "", "", diagnostic(ErrorCodeUnsupportedFunction, "function/operator "+op+" is outside the server profile")
}

// textMatch is an exact, case-sensitive CONTAINS, STARTS_WITH or ENDS_WITH.
// An empty search text matches.
func (b *planBuilder) textMatch(op, x, y string) string {
	switch op {
	case "CONTAINS":
		if b.sqlite {
			return "(instr(" + x + "," + y + ")>0)"
		}
		return "(strpos(" + x + "," + y + ")>0)"
	case "STARTS_WITH":
		// The first occurrence is at the start exactly when text starts with it.
		if b.sqlite {
			return "(instr(" + x + "," + y + ")=1)"
		}
		return "(strpos(" + x + "," + y + ")=1)"
	}
	if b.sqlite {
		// Byte suffixes of valid UTF-8 are code point suffixes.
		bx, by := "CAST("+x+" AS BLOB)", "CAST("+y+" AS BLOB)"
		return "CASE WHEN " + x + " IS NULL OR " + y + " IS NULL THEN NULL ELSE (length(" + by + ")<=length(" + bx + ") AND substr(" + bx + ",length(" + bx + ")-length(" + by + ")+1)=" + by + ") END"
	}
	return "(right(" + x + ",char_length(" + y + "))=" + y + ` COLLATE "C")`
}

// caseMapped is LOWER or UPPER of text SQL. The browser applies JavaScript's
// full, context-sensitive Unicode case mapping; neither engine does, so a few
// characters differ (see docs/backend-metrics.md). SQLite calls Go's simple
// Unicode case mapping (strings.ToLower/ToUpper). PostgreSQL uses
// lower()/upper() under the database's default collation: its LC_CTYPE (or
// ICU locale) maps non-ASCII letters, and a C or POSIX default maps only ASCII.
func (b *planBuilder) caseMapped(op, x string) string {
	fn := strings.ToLower(op)
	if b.sqlite {
		return b.emit("qt_v2_"+fn+"("+sqliteBytes(x)+")", b.nullError(), "text").Value + b.collation()
	}
	return fn + "((" + x + `) COLLATE "default")` + b.collation()
}

// sqliteBytes passes text to a registered function as a BLOB: some drivers
// hand a function's TEXT argument over only up to an embedded NUL.
func sqliteBytes(text string) string { return "CAST(" + text + " AS BLOB)" }

func formulaRegexFunction(op string) bool {
	return op == "REGEX_TEST" || op == "REGEX_EXTRACT" || op == "REGEX_REPLACE"
}

// regex compiles REGEX_TEST, REGEX_EXTRACT and REGEX_REPLACE for SQLite. The
// pattern and flags must be text literals within the translated subset (see
// formula_regex.go); PostgreSQL's regex dialect differs and is refused.
func (b *planBuilder) regex(n *exprNode) (ValueSQL, error) {
	lo, hi, flagsAt := 2, 3, 2
	switch n.op {
	case "REGEX_EXTRACT":
		hi, flagsAt = 4, 3
	case "REGEX_REPLACE":
		lo, hi, flagsAt = 3, 4, 3
	}
	if len(n.args) < lo || len(n.args) > hi {
		return ValueSQL{}, diagnostic(ErrorCodeArity, "invalid argument count for "+n.op)
	}
	if !b.sqlite {
		return ValueSQL{}, diagnostic(ErrorCodeUnsupportedRegex, "regex formulas are outside the PostgreSQL profile")
	}
	literal := func(i int) (string, bool) {
		if i >= len(n.args) {
			return "", true
		}
		s, ok := n.args[i].value.(string)
		return s, ok && n.args[i].op == "literal"
	}
	pattern, ok := literal(1)
	flags, flagsOK := literal(flagsAt)
	if !ok || !flagsOK {
		return ValueSQL{}, diagnostic(ErrorCodeUnsupportedRegex, n.op+" requires text literal pattern and flags in the server profile")
	}
	re, err := formulaRegexFor(n.op, pattern, flags)
	if err != nil {
		return ValueSQL{}, err
	}
	text, err := b.row(n.args[0])
	if err != nil {
		return ValueSQL{}, err
	}
	if err = requireType(text, "text"); err != nil {
		return ValueSQL{}, err
	}
	p := b.param(re.re2, "text")
	var v, e, t string
	switch n.op {
	case "REGEX_TEST":
		call := b.emit("qt_v2_regex_test("+sqliteBytes(text.Value)+","+p+")", text.Error, "bool")
		v, e, t = call.Value, call.Error, "bool"
	case "REGEX_EXTRACT":
		group := ValueSQL{Value: "0", Error: b.nullError(), Type: "number"}
		if len(n.args) > 2 {
			if group, err = b.row(n.args[2]); err != nil {
				return ValueSQL{}, err
			}
			if err = requireType(group, "number"); err != nil {
				return ValueSQL{}, err
			}
		}
		// The browser checks the group (an integer 0–100) after the match.
		valid := "(" + group.Value + "=CAST(" + group.Value + " AS INTEGER) AND " + group.Value + ">=0 AND " + group.Value + "<=100)"
		e = "COALESCE(" + text.Error + "," + group.Error + ",CASE WHEN " + text.Value + " IS NOT NULL AND " + group.Value + " IS NOT NULL AND NOT " + valid + " THEN 'argument_range' END)"
		call := b.emit("CASE WHEN "+valid+" THEN qt_v2_regex_extract("+sqliteBytes(text.Value)+","+p+",CAST("+group.Value+" AS INTEGER)) END", e, "text")
		v, e, t = call.Value+b.collation(), call.Error, "text"
	case "REGEX_REPLACE":
		replacement, err := b.row(n.args[2])
		if err != nil {
			return ValueSQL{}, err
		}
		if err = requireType(replacement, "text"); err != nil {
			return ValueSQL{}, err
		}
		// The value is NULL only for NULL input or a failed replacement,
		// whose code the companion function returns.
		call := b.emit("qt_v2_regex_replace("+sqliteBytes(text.Value)+","+p+","+sqliteBytes(replacement.Value)+")", "COALESCE("+text.Error+","+replacement.Error+")", "text")
		v = call.Value + b.collation()
		e = "COALESCE(" + call.Error + ",CASE WHEN " + call.Value + " IS NULL AND " + text.Value + " IS NOT NULL AND " + replacement.Value + " IS NOT NULL THEN qt_v2_regex_replace_error(" + sqliteBytes(text.Value) + "," + p + "," + sqliteBytes(replacement.Value) + ") END)"
		t = "text"
	}
	out := b.emitNative(v, e, t)
	return b.emitNative("CASE WHEN "+out.Error+" IS NULL THEN "+out.Value+" END", out.Error, t), nil
}
