package querytable

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Formula regex functions (REGEX_TEST, REGEX_EXTRACT, REGEX_REPLACE) are
// specified as JavaScript RegExp with the u flag plus optional i, m and s.
// Go's RE2 shares most of that syntax but not all of its meaning, so the
// server translates a validated subset whose matches, captures and
// replacements are identical, and refuses every other pattern with
// unsupported_regex instead of approximating it.
//
// Refused: lookaround, backreferences, named groups, \p{...}, lone surrogate
// escapes, repetition counts above 1,000 (an RE2 limit), quantifiers over a
// subpattern that can match empty (JavaScript rejects empty iterations, RE2
// accepts them), and the m flag together with ^ or $ (JavaScript also breaks
// lines at \r, U+2028 and U+2029). With the i flag every literal character and
// range must be ASCII (case folding of other characters follows each engine's
// Unicode version) and \b/\B are refused (JavaScript's u+i word set includes
// U+017F and U+212A). REGEX_EXTRACT and REGEX_REPLACE also refuse capture
// groups inside a repeated quantifier (JavaScript clears them on every
// iteration), and REGEX_REPLACE refuses patterns that can match empty
// (JavaScript keeps an empty match right after a match; RE2 drops it).
//
// Translation spells out the JavaScript meaning: . excludes \n, \r, U+2028
// and U+2029 (unless s), and \s/\S use the ECMAScript white space and line
// terminator set, the same set as TRIM.

// maxFormulaTextUnits is the browser's text result bound in UTF-16 code
// units ("100,000 characters"). Function results are checked against it
// exactly; source text operands use the stricter maxFormulaTextBytes.
const maxFormulaTextUnits = 100000

// maxFormulaRegexLength is the browser's pattern limit in UTF-16 code units.
const maxFormulaRegexLength = 2000

// jsWhitespace is ECMAScript WhiteSpace plus LineTerminator: the characters
// String.prototype.trim removes and /\s/u matches.
const jsWhitespace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

type runeRange struct{ lo, hi rune }

var jsWhitespaceRanges = func() []runeRange {
	out := []runeRange{}
	for _, r := range jsWhitespace {
		if n := len(out); n > 0 && out[n-1].hi+1 == r {
			out[n-1].hi = r
		} else {
			out = append(out, runeRange{r, r})
		}
	}
	return out
}()

// jsNonWhitespaceRanges complements jsWhitespaceRanges over Unicode scalar
// values (surrogates never occur in valid UTF-8 text).
var jsNonWhitespaceRanges = func() []runeRange {
	out := []runeRange{}
	next := rune(0)
	add := func(lo, hi rune) {
		for _, gap := range []runeRange{{lo, min(hi, 0xd7ff)}, {max(lo, 0xe000), hi}} {
			if gap.lo <= gap.hi {
				out = append(out, gap)
			}
		}
	}
	for _, r := range jsWhitespaceRanges {
		if r.lo > next {
			add(next, r.lo-1)
		}
		next = r.hi + 1
	}
	add(next, utf8.MaxRune)
	return out
}()

// formulaRegex is a translated pattern and the properties the functions check.
type formulaRegex struct {
	re2    string
	groups int
	// nullable reports that the whole pattern can match the empty string.
	nullable bool
	// repeatedCapture reports a capture group inside a quantifier whose
	// maximum exceeds one.
	repeatedCapture bool
}

type jsRegexParser struct {
	src                           []rune
	at                            int
	ignoreCase, dotAll, multiline bool
	groups                        int
	anchors, boundaries, nonASCII bool
	repeatedCapture               bool
}

func regexRefusal(format string, args ...any) error {
	return diagnostic(ErrorCodeUnsupportedRegex, fmt.Sprintf(format, args...))
}

// translateFormulaRegex validates a JavaScript pattern and flags and returns
// the equivalent RE2 source, or an unsupported_regex diagnostic.
func translateFormulaRegex(pattern, flags string) (formulaRegex, error) {
	seen := map[rune]bool{}
	for _, f := range flags {
		if (f != 'i' && f != 'm' && f != 's') || seen[f] {
			return formulaRegex{}, regexRefusal("regex flags must be unique i, m, or s")
		}
		seen[f] = true
	}
	if utf16Length(pattern) > maxFormulaRegexLength {
		return formulaRegex{}, regexRefusal("regex pattern exceeds 2,000 characters")
	}
	p := &jsRegexParser{src: []rune(pattern), ignoreCase: seen['i'], dotAll: seen['s'], multiline: seen['m']}
	body, nullable, err := p.disjunction()
	if err != nil {
		return formulaRegex{}, err
	}
	if p.at < len(p.src) {
		// Only an unbalanced ")" stops a top-level disjunction early.
		return formulaRegex{}, regexRefusal("invalid regex pattern: unmatched )")
	}
	if p.multiline && p.anchors {
		return formulaRegex{}, regexRefusal("the m flag with ^ or $ is outside the server regex profile")
	}
	if p.ignoreCase && p.nonASCII {
		return formulaRegex{}, regexRefusal("the i flag is supported only with ASCII literal characters")
	}
	if p.ignoreCase && p.boundaries {
		return formulaRegex{}, regexRefusal("the i flag with \\b or \\B is outside the server regex profile")
	}
	if p.ignoreCase {
		body = "(?i)" + body
	}
	// RE2 reads ^ and $ as text anchors without its own m flag: the
	// JavaScript meaning when m is absent (and m is refused with anchors).
	if _, err = regexp.Compile(body); err != nil {
		return formulaRegex{}, regexRefusal("regex pattern is outside the server regex profile: %v", err)
	}
	return formulaRegex{re2: body, groups: p.groups, nullable: nullable, repeatedCapture: p.repeatedCapture}, nil
}

// formulaRegexFor translates the pattern of one regex function and applies
// that function's own restrictions.
func formulaRegexFor(function, pattern, flags string) (formulaRegex, error) {
	re, err := translateFormulaRegex(pattern, flags)
	if err != nil {
		return re, err
	}
	if function != "REGEX_TEST" && re.repeatedCapture {
		return re, regexRefusal("capture groups inside a repeated quantifier are outside the server regex profile")
	}
	if function == "REGEX_REPLACE" && re.nullable {
		return re, regexRefusal("REGEX_REPLACE patterns that can match empty text are outside the server regex profile")
	}
	return re, nil
}

func (p *jsRegexParser) peek() (rune, bool) {
	if p.at < len(p.src) {
		return p.src[p.at], true
	}
	return 0, false
}

func (p *jsRegexParser) eat(r rune) bool {
	if c, ok := p.peek(); ok && c == r {
		p.at++
		return true
	}
	return false
}

func (p *jsRegexParser) disjunction() (string, bool, error) {
	alternatives := []string{}
	nullable := false
	for {
		alt, n, err := p.alternative()
		if err != nil {
			return "", false, err
		}
		alternatives = append(alternatives, alt)
		nullable = nullable || n
		if !p.eat('|') {
			return strings.Join(alternatives, "|"), nullable, nil
		}
	}
}

func (p *jsRegexParser) alternative() (string, bool, error) {
	var out strings.Builder
	nullable := true
	for {
		c, ok := p.peek()
		if !ok || c == '|' || c == ')' {
			return out.String(), nullable, nil
		}
		term, n, err := p.term()
		if err != nil {
			return "", false, err
		}
		out.WriteString(term)
		nullable = nullable && n
	}
}

func (p *jsRegexParser) term() (string, bool, error) {
	c, _ := p.peek()
	switch c {
	case '^', '$':
		p.at++
		p.anchors = true
		return string(c), true, p.noQuantifier()
	case '\\':
		if p.at+1 < len(p.src) && (p.src[p.at+1] == 'b' || p.src[p.at+1] == 'B') {
			p.at += 2
			p.boundaries = true
			return `\` + string(p.src[p.at-1]), true, p.noQuantifier()
		}
	case '(':
		if p.at+2 < len(p.src) && p.src[p.at+1] == '?' && (p.src[p.at+2] == '=' || p.src[p.at+2] == '!' || p.src[p.at+2] == '<') {
			return "", false, regexRefusal("lookaround and named groups are outside the server regex profile")
		}
	}
	captures := p.groups
	atom, nullable, err := p.atom()
	if err != nil {
		return "", false, err
	}
	quantifier, lo, hi, ok, err := p.quantifier()
	if err != nil || !ok {
		return atom, nullable, err
	}
	if hi == 0 {
		// {0} never applies its atom; captures inside stay unmatched in both.
		return "(?:" + atom + "){0}", true, nil
	}
	if nullable {
		return "", false, regexRefusal("a quantifier over a subpattern that can match empty text is outside the server regex profile")
	}
	if p.groups > captures && (hi < 0 || hi > 1) {
		p.repeatedCapture = true
	}
	return "(?:" + atom + ")" + quantifier, lo == 0, nil
}

// noQuantifier rejects a quantifier after an assertion, as the u flag does.
func (p *jsRegexParser) noQuantifier() error {
	if c, ok := p.peek(); ok && (c == '*' || c == '+' || c == '?' || c == '{') {
		return regexRefusal("invalid regex pattern: nothing to repeat")
	}
	return nil
}

// quantifier returns RE2 source and bounds; hi is -1 when unbounded.
func (p *jsRegexParser) quantifier() (string, int, int, bool, error) {
	c, ok := p.peek()
	if !ok {
		return "", 0, 0, false, nil
	}
	var lo, hi int
	var out string
	switch c {
	case '*':
		p.at++
		lo, hi, out = 0, -1, "*"
	case '+':
		p.at++
		lo, hi, out = 1, -1, "+"
	case '?':
		p.at++
		lo, hi, out = 0, 1, "?"
	case '{':
		p.at++
		var err error
		if lo, err = p.decimal(); err != nil {
			return "", 0, 0, false, err
		}
		hi = lo
		if p.eat(',') {
			hi = -1
			if d, ok := p.peek(); ok && d >= '0' && d <= '9' {
				if hi, err = p.decimal(); err != nil {
					return "", 0, 0, false, err
				}
			}
		}
		if !p.eat('}') {
			return "", 0, 0, false, regexRefusal("invalid regex pattern: incomplete quantifier")
		}
		if hi >= 0 && hi < lo {
			return "", 0, 0, false, regexRefusal("invalid regex pattern: numbers out of order in quantifier")
		}
		if lo > 1000 || hi > 1000 {
			return "", 0, 0, false, regexRefusal("regex repetition counts above 1,000 are outside the server regex profile")
		}
		switch {
		case hi == lo:
			out = fmt.Sprintf("{%d}", lo)
		case hi < 0:
			out = fmt.Sprintf("{%d,}", lo)
		default:
			out = fmt.Sprintf("{%d,%d}", lo, hi)
		}
	default:
		return "", 0, 0, false, nil
	}
	if p.eat('?') {
		out += "?"
	}
	return out, lo, hi, true, nil
}

func (p *jsRegexParser) decimal() (int, error) {
	start := p.at
	for p.at < len(p.src) && p.src[p.at] >= '0' && p.src[p.at] <= '9' {
		p.at++
	}
	if p.at == start {
		return 0, regexRefusal("invalid regex pattern: incomplete quantifier")
	}
	digits := string(p.src[start:p.at])
	if len(digits) > 7 {
		return 0, regexRefusal("regex repetition counts above 1,000 are outside the server regex profile")
	}
	n, _ := strconv.Atoi(digits)
	return n, nil
}

func (p *jsRegexParser) atom() (string, bool, error) {
	c, _ := p.peek()
	switch c {
	case '.':
		p.at++
		if p.dotAll {
			return `(?s:.)`, false, nil
		}
		return `[^\n\r\x{2028}\x{2029}]`, false, nil
	case '(':
		p.at++
		capture := true
		if p.eat('?') {
			if !p.eat(':') {
				return "", false, regexRefusal("group modifiers are outside the server regex profile")
			}
			capture = false
		}
		if capture {
			p.groups++
		}
		body, nullable, err := p.disjunction()
		if err != nil {
			return "", false, err
		}
		if !p.eat(')') {
			return "", false, regexRefusal("invalid regex pattern: unterminated group")
		}
		if capture {
			return "(" + body + ")", nullable, nil
		}
		return "(?:" + body + ")", nullable, nil
	case '[':
		p.at++
		class, err := p.class()
		return class, false, err
	case '\\':
		p.at++
		return p.atomEscape()
	case '*', '+', '?', '{', '}', ']', ')':
		return "", false, regexRefusal("invalid regex pattern: unexpected %q", c)
	}
	p.at++
	return p.literal(c), false, nil
}

func (p *jsRegexParser) literal(r rune) string {
	if r > 0x7f {
		p.nonASCII = true
	}
	return fmt.Sprintf(`\x{%X}`, r)
}

func rangesSQL(ranges []runeRange) string {
	var out strings.Builder
	for _, r := range ranges {
		fmt.Fprintf(&out, `\x{%X}`, r.lo)
		if r.hi != r.lo {
			fmt.Fprintf(&out, `-\x{%X}`, r.hi)
		}
	}
	return out.String()
}

func (p *jsRegexParser) atomEscape() (string, bool, error) {
	c, ok := p.peek()
	if !ok {
		return "", false, regexRefusal("invalid regex pattern: \\ at end of pattern")
	}
	switch c {
	case 'd', 'D', 'w', 'W':
		p.at++
		return `\` + string(c), false, nil
	case 's':
		p.at++
		return "[" + rangesSQL(jsWhitespaceRanges) + "]", false, nil
	case 'S':
		p.at++
		return "[" + rangesSQL(jsNonWhitespaceRanges) + "]", false, nil
	}
	r, err := p.characterEscape(false)
	if err != nil {
		return "", false, err
	}
	return p.literal(r), false, nil
}

// characterEscape reads the escape after a backslash that denotes one
// character (u-flag syntax). inClass admits \b (backspace) and \-.
func (p *jsRegexParser) characterEscape(inClass bool) (rune, error) {
	c, ok := p.peek()
	if !ok {
		return 0, regexRefusal("invalid regex pattern: \\ at end of pattern")
	}
	p.at++
	switch c {
	case 't':
		return '\t', nil
	case 'n':
		return '\n', nil
	case 'v':
		return '\v', nil
	case 'f':
		return '\f', nil
	case 'r':
		return '\r', nil
	case '0':
		if d, ok := p.peek(); ok && d >= '0' && d <= '9' {
			return 0, regexRefusal("invalid regex pattern: invalid decimal escape")
		}
		return 0, nil
	case 'c':
		if l, ok := p.peek(); ok && (l >= 'a' && l <= 'z' || l >= 'A' && l <= 'Z') {
			p.at++
			return l % 32, nil
		}
		return 0, regexRefusal("invalid regex pattern: invalid control escape")
	case 'x':
		v, ok := p.hex(2)
		if !ok {
			return 0, regexRefusal("invalid regex pattern: invalid \\x escape")
		}
		return v, nil
	case 'u':
		if p.eat('{') {
			start := p.at
			for p.at < len(p.src) && isHex(p.src[p.at]) {
				p.at++
			}
			v, err := strconv.ParseUint(string(p.src[start:p.at]), 16, 32)
			if p.at == start || err != nil || v > utf8.MaxRune || !p.eat('}') {
				return 0, regexRefusal("invalid regex pattern: invalid \\u escape")
			}
			if v >= 0xd800 && v <= 0xdfff {
				return 0, regexRefusal("lone surrogate escapes are outside the server regex profile")
			}
			return rune(v), nil
		}
		v, ok := p.hex(4)
		if !ok {
			return 0, regexRefusal("invalid regex pattern: invalid \\u escape")
		}
		if v >= 0xd800 && v <= 0xdbff && p.at+1 < len(p.src) && p.src[p.at] == '\\' && p.src[p.at+1] == 'u' {
			save := p.at
			p.at += 2
			if low, ok := p.hex(4); ok && low >= 0xdc00 && low <= 0xdfff {
				return (v-0xd800)<<10 + (low - 0xdc00) + 0x10000, nil
			}
			p.at = save
		}
		if v >= 0xd800 && v <= 0xdfff {
			return 0, regexRefusal("lone surrogate escapes are outside the server regex profile")
		}
		return v, nil
	case '^', '$', '\\', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/':
		return c, nil
	case '-':
		if inClass {
			return c, nil
		}
	case 'b':
		if inClass {
			return '\b', nil
		}
	case 'k':
		return 0, regexRefusal("backreferences are outside the server regex profile")
	case 'p', 'P':
		return 0, regexRefusal("Unicode property escapes are outside the server regex profile")
	}
	if c >= '1' && c <= '9' {
		return 0, regexRefusal("backreferences are outside the server regex profile")
	}
	return 0, regexRefusal("invalid regex pattern: invalid escape \\%c", c)
}

func isHex(r rune) bool { return r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F' }

func (p *jsRegexParser) hex(n int) (rune, bool) {
	if p.at+n > len(p.src) {
		return 0, false
	}
	v := rune(0)
	for _, r := range p.src[p.at : p.at+n] {
		if !isHex(r) {
			return 0, false
		}
		d, _ := strconv.ParseUint(string(r), 16, 8)
		v = v*16 + rune(d)
	}
	p.at += n
	return v, true
}

// class reads a character class after "[" and returns its RE2 source.
func (p *jsRegexParser) class() (string, error) {
	negated := p.eat('^')
	var items strings.Builder
	empty := true
	for {
		c, ok := p.peek()
		if !ok {
			return "", regexRefusal("invalid regex pattern: unterminated character class")
		}
		if c == ']' {
			p.at++
			break
		}
		empty = false
		lo, set, err := p.classAtom()
		if err != nil {
			return "", err
		}
		if d, ok := p.peek(); ok && d == '-' && p.at+1 < len(p.src) && p.src[p.at+1] != ']' {
			p.at++
			hi, hiSet, err := p.classAtom()
			if err != nil {
				return "", err
			}
			if set != "" || hiSet != "" {
				return "", regexRefusal("invalid regex pattern: invalid character class range")
			}
			if hi < lo {
				return "", regexRefusal("invalid regex pattern: range out of order in character class")
			}
			if lo > 0x7f || hi > 0x7f {
				p.nonASCII = true
			}
			fmt.Fprintf(&items, `\x{%X}-\x{%X}`, lo, hi)
			continue
		}
		if set != "" {
			items.WriteString(set)
		} else {
			items.WriteString(p.literal(lo))
		}
	}
	switch {
	case empty && negated:
		return `(?s:.)`, nil
	case empty:
		return `[^\x{0}-\x{10FFFF}]`, nil
	case negated:
		return "[^" + items.String() + "]", nil
	}
	return "[" + items.String() + "]", nil
}

// classAtom returns one character, or the RE2 class items of an escape.
func (p *jsRegexParser) classAtom() (rune, string, error) {
	c, _ := p.peek()
	p.at++
	if c != '\\' {
		return c, "", nil
	}
	e, ok := p.peek()
	if !ok {
		return 0, "", regexRefusal("invalid regex pattern: \\ at end of pattern")
	}
	switch e {
	case 'd', 'D', 'w', 'W':
		p.at++
		return 0, `\` + string(e), nil
	case 's':
		p.at++
		return 0, rangesSQL(jsWhitespaceRanges), nil
	case 'S':
		p.at++
		return 0, rangesSQL(jsNonWhitespaceRanges), nil
	case 'B':
		return 0, "", regexRefusal("invalid regex pattern: invalid class escape")
	}
	r, err := p.characterEscape(true)
	return r, "", err
}

// replaceFormulaRegex is REGEX_REPLACE's runtime: every match, the
// browser's replacement syntax ($$, $&, $1–$99) and its size bounds. It
// returns an error code instead of a value for an invalid replacement or an
// oversized result. Callers have refused patterns that can match empty.
func replaceFormulaRegex(re *regexp.Regexp, value, replacement string) (string, string) {
	matches := re.FindAllStringSubmatchIndex(value, -1)
	if len(matches) == 0 {
		return value, ""
	}
	groups := re.NumSubexp()
	var out, piece strings.Builder
	produced, last := 0, 0
	for _, m := range matches {
		out.WriteString(value[last:m[0]])
		piece.Reset()
		for i := 0; i < len(replacement); i++ {
			c := replacement[i]
			if c != '$' || i+1 >= len(replacement) {
				piece.WriteByte(c)
				continue
			}
			next := replacement[i+1]
			switch {
			case next == '$':
				piece.WriteByte('$')
				i++
			case next == '&':
				piece.WriteString(value[m[0]:m[1]])
				i++
			case next == '`' || next == '\'':
				return "", "regex_replacement"
			case next >= '0' && next <= '9':
				digits := 1
				if i+2 < len(replacement) && replacement[i+2] >= '0' && replacement[i+2] <= '9' {
					digits = 2
				}
				n, _ := strconv.Atoi(replacement[i+1 : i+1+digits])
				if n < 1 || n > groups {
					return "", "regex_replacement"
				}
				if m[2*n] >= 0 {
					piece.WriteString(value[m[2*n]:m[2*n+1]])
				}
				i += digits
			default:
				piece.WriteByte(c)
			}
		}
		produced += utf16Length(piece.String())
		if produced > maxFormulaTextUnits {
			return "", "text_range"
		}
		out.WriteString(piece.String())
		last = m[1]
	}
	out.WriteString(value[last:])
	result := out.String()
	if utf16Length(result) > maxFormulaTextUnits {
		return "", "text_range"
	}
	return result, ""
}

// extractFormulaRegex is REGEX_EXTRACT's runtime: the group of the first
// match, or false for no match, an absent group or one that did not take part.
func extractFormulaRegex(re *regexp.Regexp, value string, group int) (string, bool) {
	m := re.FindStringSubmatchIndex(value)
	if m == nil || group > re.NumSubexp() || m[2*group] < 0 {
		return "", false
	}
	return value[m[2*group]:m[2*group+1]], true
}

// wordFormulaCount is WORD_COUNT: maximal runs of characters outside the
// ECMAScript white space set, as text.match(/\S+/gu).length.
func wordFormulaCount(value string) int {
	count, inWord := 0, false
	for _, r := range value {
		space := strings.ContainsRune(jsWhitespace, r)
		if !space && !inWord {
			count++
		}
		inWord = !space
	}
	return count
}

// splitFormulaCount is the element count of JavaScript's text.split(sep):
// an empty separator yields UTF-16 code units.
func splitFormulaCount(value, separator string) int {
	if separator == "" {
		return utf16Length(value)
	}
	return strings.Count(value, separator) + 1
}
