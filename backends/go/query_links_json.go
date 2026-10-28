package querytable

// JavaScript value semantics for the query link codec. Link normalization must
// reproduce @pythia-software/query-table-core byte for byte, so it works on a
// JSON tree with JavaScript's rules rather than on encoding/json values:
//
//   - objects keep insertion order, except that array-index keys ("0", "7")
//     come first in ascending order, as in every JavaScript engine;
//   - a duplicate key keeps its first position and its last value (JSON.parse);
//   - strings are WTF-8, so a lone UTF-16 surrogate from a "\ud800" escape
//     survives a round trip, and lengths count UTF-16 code units;
//   - numbers are float64 and print as Number.prototype.toString does;
//   - serialization matches JSON.stringify, including its escapes.
//
// A nil *jsValue is JavaScript's undefined.

import (
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

type jsKind uint8

const (
	jsNull jsKind = iota
	jsBool
	jsNumber
	jsString
	jsArray
	jsObject
)

type jsValue struct {
	kind jsKind
	b    bool
	n    float64
	s    string
	a    []*jsValue
	o    *jsMembers
}

// jsMembers keeps array-index keys apart from the others, so that inserting
// many of them stays linear: they are sorted once, when next enumerated.
type jsMembers struct {
	index    []string // array-index keys, in numeric order once sorted
	unsorted bool
	names    []string // other keys, in insertion order
	values   map[string]*jsValue
}

// keys lists the members in JavaScript enumeration order. Callers must not
// modify the result.
func (o *jsMembers) keys() []string {
	if o.unsorted {
		sort.Slice(o.index, func(i, j int) bool { return indexLess(o.index[i], o.index[j]) })
		o.unsorted = false
	}
	if len(o.index) == 0 {
		return o.names
	}
	if len(o.names) == 0 {
		return o.index
	}
	return append(append(make([]string, 0, len(o.values)), o.index...), o.names...)
}

func (o *jsMembers) size() int { return len(o.values) }

// indexLess orders canonical array indices, which have no leading zeros.
func indexLess(a, b string) bool {
	if len(a) != len(b) {
		return len(a) < len(b)
	}
	return a < b
}

func jsNullValue() *jsValue       { return &jsValue{kind: jsNull} }
func jsBoolValue(b bool) *jsValue { return &jsValue{kind: jsBool, b: b} }
func jsNum(n float64) *jsValue    { return &jsValue{kind: jsNumber, n: n} }
func jsStr(s string) *jsValue     { return &jsValue{kind: jsString, s: s} }
func jsArr(items ...*jsValue) *jsValue {
	return &jsValue{kind: jsArray, a: append([]*jsValue{}, items...)}
}
func jsObj() *jsValue {
	return &jsValue{kind: jsObject, o: &jsMembers{values: map[string]*jsValue{}}}
}

func jsStrings(values []string) *jsValue {
	out := jsArr()
	for _, value := range values {
		out.a = append(out.a, jsStr(value))
	}
	return out
}

func (v *jsValue) isRecord() bool { return v != nil && v.kind == jsObject }
func (v *jsValue) isArray() bool  { return v != nil && v.kind == jsArray }
func (v *jsValue) isString() bool { return v != nil && v.kind == jsString }
func (v *jsValue) isNumber() bool { return v != nil && v.kind == jsNumber }

// isNullish is `v == null`: undefined or null.
func (v *jsValue) isNullish() bool { return v == nil || v.kind == jsNull }

// get reads a member of an object; anything else has no members.
func (v *jsValue) get(key string) *jsValue {
	if !v.isRecord() {
		return nil
	}
	return v.o.values[key]
}

// set assigns an own data property, keeping an existing key's position.
func (v *jsValue) set(key string, value *jsValue) *jsValue {
	o := v.o
	if _, ok := o.values[key]; ok {
		o.values[key] = value
		return v
	}
	o.values[key] = value
	if _, ok := arrayIndex(key); ok {
		if n := len(o.index); n > 0 && !indexLess(o.index[n-1], key) {
			o.unsorted = true
		}
		o.index = append(o.index, key)
		return v
	}
	o.names = append(o.names, key)
	return v
}

func (v *jsValue) del(key string) {
	o := v.o
	if _, ok := o.values[key]; !ok {
		return
	}
	delete(o.values, key)
	remove := func(keys []string) []string {
		for i, k := range keys {
			if k == key {
				return append(keys[:i], keys[i+1:]...)
			}
		}
		return keys
	}
	o.index = remove(o.index)
	o.names = remove(o.names)
}

// spread is `{ ...v }`: a shallow copy of an object's own members.
func (v *jsValue) spread() *jsValue {
	out := jsObj()
	if v.isRecord() {
		for _, key := range v.o.keys() {
			out.set(key, v.o.values[key])
		}
	}
	return out
}

// arrayIndex reports whether a property key is an array index, which every
// JavaScript engine enumerates first and in numeric order.
func arrayIndex(key string) (uint64, bool) {
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	var n uint64
	for i := 0; i < len(key); i++ {
		if key[i] < '0' || key[i] > '9' {
			return 0, false
		}
		n = n*10 + uint64(key[i]-'0')
	}
	return n, n <= 4294967294
}

// truthy is JavaScript's ToBoolean.
func (v *jsValue) truthy() bool {
	if v == nil {
		return false
	}
	switch v.kind {
	case jsNull:
		return false
	case jsBool:
		return v.b
	case jsNumber:
		return v.n != 0 && !math.IsNaN(v.n)
	case jsString:
		return v.s != ""
	}
	return true
}

// jsThrow is a JavaScript exception raised during normalization. It is a
// panic so that normalization reads like its TypeScript original; catchJS and
// the codec entry points recover it, as the TypeScript try blocks do.
type jsThrow struct{ reason string }

func throwJS(reason string) { panic(jsThrow{reason}) }

// catchJS runs fn and reports whether it threw a jsThrow.
func catchJS(fn func()) (threw bool) {
	defer func() {
		if r := recover(); r != nil {
			if _, ok := r.(jsThrow); !ok {
				panic(r)
			}
			threw = true
		}
	}()
	fn()
	return false
}

// maxStringNesting bounds the array nesting String() will join. V8 runs out of
// stack at about 2,600 levels (a RangeError); stopping earlier keeps Go on the
// rejecting side of that engine-dependent limit.
const maxStringNesting = 1000

// jsToString is JavaScript's String(value) on a JSON value. Like JavaScript,
// it throws for an object with its own "toString" member (which shadows the
// prototype method with a value that is not callable), including inside an
// array, and for arrays nested too deeply.
func jsToString(v *jsValue) string {
	var b strings.Builder
	appendJSToString(&b, v, 0)
	return b.String()
}

func appendJSToString(b *strings.Builder, v *jsValue, depth int) {
	if v == nil {
		b.WriteString("undefined")
		return
	}
	switch v.kind {
	case jsNull:
		b.WriteString("null")
	case jsBool:
		b.WriteString(strconv.FormatBool(v.b))
	case jsNumber:
		b.WriteString(formatJSNumber(v.n))
	case jsString:
		b.WriteString(v.s)
	case jsArray:
		if depth >= maxStringNesting {
			throwJS("Maximum call stack size exceeded")
		}
		for i, item := range v.a {
			if i > 0 {
				b.WriteByte(',')
			}
			if !item.isNullish() {
				appendJSToString(b, item, depth+1)
			}
		}
	default:
		if _, own := v.o.values["toString"]; own {
			throwJS("Cannot convert object to primitive value")
		}
		b.WriteString("[object Object]")
	}
}

// formatJSNumber is Number.prototype.toString for a float64.
func formatJSNumber(n float64) string {
	switch {
	case math.IsNaN(n):
		return "NaN"
	case math.IsInf(n, 1):
		return "Infinity"
	case math.IsInf(n, -1):
		return "-Infinity"
	case n == 0:
		return "0"
	}
	abs := math.Abs(n)
	if abs < 1e-6 || abs >= 1e21 {
		s := strconv.FormatFloat(n, 'e', -1, 64)
		mantissa, exponent, _ := strings.Cut(s, "e")
		sign := exponent[0]
		exponent = strings.TrimLeft(exponent[1:], "0")
		return mantissa + "e" + string(sign) + exponent
	}
	return strconv.FormatFloat(n, 'f', -1, 64)
}

func jsIsInteger(v *jsValue) bool {
	return v.isNumber() && !math.IsInf(v.n, 0) && !math.IsNaN(v.n) && math.Trunc(v.n) == v.n
}

func jsIsSafeInteger(v *jsValue) bool {
	return jsIsInteger(v) && math.Abs(v.n) <= maxSafeInteger
}

func jsIsFinite(v *jsValue) bool {
	return v.isNumber() && !math.IsInf(v.n, 0) && !math.IsNaN(v.n)
}

// jsRound is Math.round: halves round toward positive infinity.
func jsRound(x float64) float64 {
	if math.IsInf(x, 0) || math.IsNaN(x) || x == math.Trunc(x) {
		return x
	}
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	if r == 0 && x < 0 {
		return math.Copysign(0, -1)
	}
	return r
}

// ---- WTF-8 strings measured in UTF-16 code units ---------------------------

// decodeWTF8 reads one code point, accepting the three-byte encoding of a lone
// surrogate. Any other invalid byte reads as U+FFFD.
func decodeWTF8(s string, i int) (rune, int) {
	if i+2 < len(s) && s[i] == 0xED && s[i+1] >= 0xA0 && s[i+1] <= 0xBF && s[i+2] >= 0x80 && s[i+2] <= 0xBF {
		return rune(0xD000 | rune(s[i+1]&0x3F)<<6 | rune(s[i+2]&0x3F)), 3
	}
	return utf8.DecodeRuneInString(s[i:])
}

func appendWTF8(b []byte, r rune) []byte {
	if r >= 0xD800 && r <= 0xDFFF {
		return append(b, byte(0xE0|r>>12), byte(0x80|(r>>6)&0x3F), byte(0x80|r&0x3F))
	}
	return utf8.AppendRune(b, r)
}

// utf16Units returns the string as JavaScript sees it.
func utf16Units(s string) []uint16 {
	units := make([]uint16, 0, len(s))
	for i := 0; i < len(s); {
		r, size := decodeWTF8(s, i)
		i += size
		if r >= 0x10000 {
			r -= 0x10000
			units = append(units, uint16(0xD800+(r>>10)), uint16(0xDC00+(r&0x3FF)))
		} else {
			units = append(units, uint16(r))
		}
	}
	return units
}

// fromUTF16 joins code units back into WTF-8, pairing surrogates where they
// form a character.
func fromUTF16(units []uint16) string {
	b := make([]byte, 0, len(units))
	for i := 0; i < len(units); i++ {
		u := rune(units[i])
		if u >= 0xD800 && u <= 0xDBFF && i+1 < len(units) && units[i+1] >= 0xDC00 && units[i+1] <= 0xDFFF {
			b = utf8.AppendRune(b, 0x10000+(u-0xD800)<<10+rune(units[i+1]-0xDC00))
			i++
			continue
		}
		b = appendWTF8(b, u)
	}
	return string(b)
}

// jsLength is String.prototype.length.
func jsLength(s string) int {
	n := 0
	for i := 0; i < len(s); {
		r, size := decodeWTF8(s, i)
		i += size
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// jsSlice is s.slice(0, n).
func jsSlice(s string, n int) string {
	units := utf16Units(s)
	if len(units) <= n {
		return s
	}
	return fromUTF16(units[:n])
}

// whatwgUTF8 decodes bytes with the WHATWG replacement algorithm used by
// TextDecoder and Node's Buffer#toString: each maximal invalid subpart becomes
// one U+FFFD.
func whatwgUTF8(input []byte) string {
	if utf8.Valid(input) {
		return string(input)
	}
	out := make([]byte, 0, len(input)+8)
	var codePoint rune
	needed, seen := 0, 0
	lower, upper := byte(0x80), byte(0xBF)
	for i := 0; i < len(input); i++ {
		b := input[i]
		if needed == 0 {
			switch {
			case b <= 0x7F:
				out = append(out, b)
			case b >= 0xC2 && b <= 0xDF:
				needed, codePoint = 1, rune(b&0x1F)
			case b >= 0xE0 && b <= 0xEF:
				if b == 0xE0 {
					lower = 0xA0
				} else if b == 0xED {
					upper = 0x9F
				}
				needed, codePoint = 2, rune(b&0x0F)
			case b >= 0xF0 && b <= 0xF4:
				if b == 0xF0 {
					lower = 0x90
				} else if b == 0xF4 {
					upper = 0x8F
				}
				needed, codePoint = 3, rune(b&0x07)
			default:
				out = utf8.AppendRune(out, utf8.RuneError)
			}
			continue
		}
		if b < lower || b > upper {
			codePoint, needed, seen = 0, 0, 0
			lower, upper = 0x80, 0xBF
			out = utf8.AppendRune(out, utf8.RuneError)
			i--
			continue
		}
		lower, upper = 0x80, 0xBF
		codePoint = codePoint<<6 | rune(b&0x3F)
		seen++
		if seen == needed {
			out = utf8.AppendRune(out, codePoint)
			codePoint, needed, seen = 0, 0, 0
		}
	}
	if needed != 0 {
		out = utf8.AppendRune(out, utf8.RuneError)
	}
	return string(out)
}

// ---- JSON.parse --------------------------------------------------------------

var errJSONSyntax = errors.New("invalid JSON")

// parseJSValue is JSON.parse over valid UTF-8 text. It is iterative, so deep
// nesting costs heap rather than stack, as in V8.
func parseJSValue(text string) (*jsValue, error) {
	p := jsonParser{text: text}
	type frame struct {
		value *jsValue
		key   string
	}
	var stack []frame
	for {
		p.space()
		var value *jsValue
		if p.pos >= len(p.text) {
			return nil, errJSONSyntax
		}
		switch c := p.text[p.pos]; {
		case c == '{':
			p.pos++
			p.space()
			if p.peek() == '}' {
				p.pos++
				value = jsObj()
				break
			}
			key, err := p.key()
			if err != nil {
				return nil, err
			}
			stack = append(stack, frame{value: jsObj(), key: key})
			continue
		case c == '[':
			p.pos++
			p.space()
			if p.peek() == ']' {
				p.pos++
				value = jsArr()
				break
			}
			stack = append(stack, frame{value: jsArr()})
			continue
		case c == '"':
			s, err := p.str()
			if err != nil {
				return nil, err
			}
			value = jsStr(s)
		case c == 't' && strings.HasPrefix(p.text[p.pos:], "true"):
			p.pos += 4
			value = jsBoolValue(true)
		case c == 'f' && strings.HasPrefix(p.text[p.pos:], "false"):
			p.pos += 5
			value = jsBoolValue(false)
		case c == 'n' && strings.HasPrefix(p.text[p.pos:], "null"):
			p.pos += 4
			value = jsNullValue()
		case c == '-' || (c >= '0' && c <= '9'):
			n, err := p.number()
			if err != nil {
				return nil, err
			}
			value = jsNum(n)
		default:
			return nil, errJSONSyntax
		}
		// Attach the completed value and close every container it completes.
		for {
			if len(stack) == 0 {
				p.space()
				if p.pos != len(p.text) {
					return nil, errJSONSyntax
				}
				return value, nil
			}
			top := &stack[len(stack)-1]
			if top.value.kind == jsObject {
				top.value.set(top.key, value)
			} else {
				top.value.a = append(top.value.a, value)
			}
			p.space()
			c := p.peek()
			if c == ',' {
				p.pos++
				if top.value.kind == jsObject {
					p.space()
					key, err := p.key()
					if err != nil {
						return nil, err
					}
					top.key = key
				}
				break
			}
			if (top.value.kind == jsObject && c == '}') || (top.value.kind == jsArray && c == ']') {
				p.pos++
				value = top.value
				stack = stack[:len(stack)-1]
				continue
			}
			return nil, errJSONSyntax
		}
	}
}

type jsonParser struct {
	text string
	pos  int
}

func (p *jsonParser) peek() byte {
	if p.pos < len(p.text) {
		return p.text[p.pos]
	}
	return 0
}

func (p *jsonParser) space() {
	for p.pos < len(p.text) {
		switch p.text[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		default:
			return
		}
	}
}

func (p *jsonParser) key() (string, error) {
	if p.peek() != '"' {
		return "", errJSONSyntax
	}
	key, err := p.str()
	if err != nil {
		return "", err
	}
	p.space()
	if p.peek() != ':' {
		return "", errJSONSyntax
	}
	p.pos++
	return key, nil
}

func (p *jsonParser) str() (string, error) {
	p.pos++ // opening quote
	start := p.pos
	for p.pos < len(p.text) {
		c := p.text[p.pos]
		if c == '"' {
			s := p.text[start:p.pos]
			p.pos++
			return s, nil
		}
		if c == '\\' || c < 0x20 {
			break
		}
		p.pos++
	}
	out := []byte(p.text[start:p.pos])
	var units []uint16 // pending \u escapes, so surrogate pairs combine
	flush := func() {
		if len(units) > 0 {
			out = append(out, fromUTF16(units)...)
			units = units[:0]
		}
	}
	for p.pos < len(p.text) {
		c := p.text[p.pos]
		switch {
		case c == '"':
			flush()
			p.pos++
			return string(out), nil
		case c < 0x20:
			return "", errJSONSyntax
		case c == '\\':
			if p.pos+1 >= len(p.text) {
				return "", errJSONSyntax
			}
			e := p.text[p.pos+1]
			if e == 'u' {
				if p.pos+6 > len(p.text) {
					return "", errJSONSyntax
				}
				unit, err := strconv.ParseUint(p.text[p.pos+2:p.pos+6], 16, 16)
				if err != nil || strings.ContainsAny(p.text[p.pos+2:p.pos+6], "+-xX_") {
					return "", errJSONSyntax
				}
				units = append(units, uint16(unit))
				p.pos += 6
				continue
			}
			flush()
			var decoded byte
			switch e {
			case '"', '\\', '/':
				decoded = e
			case 'b':
				decoded = '\b'
			case 'f':
				decoded = '\f'
			case 'n':
				decoded = '\n'
			case 'r':
				decoded = '\r'
			case 't':
				decoded = '\t'
			default:
				return "", errJSONSyntax
			}
			out = append(out, decoded)
			p.pos += 2
		default:
			flush()
			out = append(out, c)
			p.pos++
		}
	}
	return "", errJSONSyntax
}

func (p *jsonParser) number() (float64, error) {
	start := p.pos
	if p.peek() == '-' {
		p.pos++
	}
	digits := func() int {
		n := 0
		for p.pos < len(p.text) && p.text[p.pos] >= '0' && p.text[p.pos] <= '9' {
			p.pos++
			n++
		}
		return n
	}
	switch {
	case p.peek() == '0':
		p.pos++
	case p.peek() >= '1' && p.peek() <= '9':
		digits()
	default:
		return 0, errJSONSyntax
	}
	if p.peek() == '.' {
		p.pos++
		if digits() == 0 {
			return 0, errJSONSyntax
		}
	}
	if c := p.peek(); c == 'e' || c == 'E' {
		p.pos++
		if c := p.peek(); c == '+' || c == '-' {
			p.pos++
		}
		if digits() == 0 {
			return 0, errJSONSyntax
		}
	}
	n, err := strconv.ParseFloat(p.text[start:p.pos], 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return 0, errJSONSyntax
	}
	return n, nil
}

// ---- JSON.stringify ----------------------------------------------------------

func stringifyJS(v *jsValue) string {
	return string(appendJS(nil, v))
}

func appendJS(b []byte, v *jsValue) []byte {
	if v == nil {
		return append(b, "null"...)
	}
	switch v.kind {
	case jsNull:
		return append(b, "null"...)
	case jsBool:
		return strconv.AppendBool(b, v.b)
	case jsNumber:
		if math.IsInf(v.n, 0) || math.IsNaN(v.n) {
			return append(b, "null"...)
		}
		return append(b, formatJSNumber(v.n)...)
	case jsString:
		return appendJSString(b, v.s)
	case jsArray:
		b = append(b, '[')
		for i, item := range v.a {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendJS(b, item)
		}
		return append(b, ']')
	}
	b = append(b, '{')
	first := true
	for _, key := range v.o.keys() {
		value := v.o.values[key]
		if value == nil {
			continue
		}
		if !first {
			b = append(b, ',')
		}
		first = false
		b = appendJSString(b, key)
		b = append(b, ':')
		b = appendJS(b, value)
	}
	return append(b, '}')
}

const hexDigits = "0123456789abcdef"

func appendJSString(b []byte, s string) []byte {
	b = append(b, '"')
	for i := 0; i < len(s); {
		r, size := decodeWTF8(s, i)
		if r >= 0xD800 && r <= 0xDBFF && i+size < len(s) {
			if low, lowSize := decodeWTF8(s, i+size); low >= 0xDC00 && low <= 0xDFFF {
				b = utf8.AppendRune(b, 0x10000+(r-0xD800)<<10+(low-0xDC00))
				i += size + lowSize
				continue
			}
		}
		i += size
		switch {
		case r == '"':
			b = append(b, '\\', '"')
		case r == '\\':
			b = append(b, '\\', '\\')
		case r == '\b':
			b = append(b, '\\', 'b')
		case r == '\f':
			b = append(b, '\\', 'f')
		case r == '\n':
			b = append(b, '\\', 'n')
		case r == '\r':
			b = append(b, '\\', 'r')
		case r == '\t':
			b = append(b, '\\', 't')
		case r < 0x20 || (r >= 0xD800 && r <= 0xDFFF):
			b = append(b, '\\', 'u', hexDigits[r>>12&0xF], hexDigits[r>>8&0xF], hexDigits[r>>4&0xF], hexDigits[r&0xF])
		default:
			b = utf8.AppendRune(b, r)
		}
	}
	return append(b, '"')
}

// sameJS compares two values as JSON.stringify(a) === JSON.stringify(b).
func sameJS(a, b *jsValue) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return stringifyJS(a) == stringifyJS(b)
}
