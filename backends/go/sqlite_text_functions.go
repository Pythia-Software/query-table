package querytable

import (
	"container/list"
	"database/sql/driver"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"
)

// sqliteTextFunctions implement the formula text functions SQLite has no
// exact native equivalent for: SPLIT's element count and the regex functions.
// Patterns are RE2 sources the compiler translated from validated JavaScript
// patterns (see formula_regex.go); a shared LRU keeps 128 compiled patterns.
func sqliteTextFunctions() []SQLiteScalarFunction {
	var mu sync.Mutex
	lru := list.New()
	cache := map[string]*list.Element{}
	type entry struct {
		pattern string
		re      *regexp.Regexp
	}
	compile := func(v driver.Value) (*regexp.Regexp, error) {
		pattern, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("invalid formula regex")
		}
		mu.Lock()
		defer mu.Unlock()
		if e := cache[pattern]; e != nil {
			lru.MoveToFront(e)
			return e.Value.(entry).re, nil
		}
		re, err := regexp.Compile(pattern)
		if err != nil {
			return nil, fmt.Errorf("invalid formula regex: %w", err)
		}
		cache[pattern] = lru.PushFront(entry{pattern, re})
		if lru.Len() > 128 {
			e := lru.Back()
			delete(cache, e.Value.(entry).pattern)
			lru.Remove(e)
		}
		return re, nil
	}
	// Operands passed the compiler's text checks and arrive as BLOBs (see
	// sqliteBytes); anything else is a compiler or registration fault.
	text := func(v driver.Value) (string, error) {
		var s string
		switch v := v.(type) {
		case string:
			s = v
		case []byte:
			s = string(v)
		default:
			return "", fmt.Errorf("formula text function requires text, got %T", v)
		}
		if !utf8.ValidString(s) {
			return "", fmt.Errorf("formula text function requires valid UTF-8")
		}
		return s, nil
	}
	fn := func(name string, n int, call func([]driver.Value) (driver.Value, error)) SQLiteScalarFunction {
		return SQLiteScalarFunction{Name: name, Arity: n, Call: func(a []driver.Value) (driver.Value, error) {
			if len(a) != n {
				return nil, fmt.Errorf("%s expects %d arguments", name, n)
			}
			for _, v := range a {
				if v == nil {
					return nil, nil
				}
			}
			return call(a)
		}}
	}
	replace := func(a []driver.Value) (string, string, error) {
		value, err := text(a[0])
		if err != nil {
			return "", "", err
		}
		re, err := compile(a[1])
		if err != nil {
			return "", "", err
		}
		replacement, err := text(a[2])
		if err != nil {
			return "", "", err
		}
		out, code := replaceFormulaRegex(re, value, replacement)
		return out, code, nil
	}
	return []SQLiteScalarFunction{
		// Go's simple Unicode case mapping: closer to JavaScript than
		// SQLite's ASCII-only lower()/upper(), but not its full mapping.
		fn("qt_v2_lower", 1, func(a []driver.Value) (driver.Value, error) {
			value, err := text(a[0])
			if err != nil {
				return nil, err
			}
			return strings.ToLower(value), nil
		}),
		fn("qt_v2_upper", 1, func(a []driver.Value) (driver.Value, error) {
			value, err := text(a[0])
			if err != nil {
				return nil, err
			}
			return strings.ToUpper(value), nil
		}),
		fn("qt_v2_length", 1, func(a []driver.Value) (driver.Value, error) {
			value, err := text(a[0])
			if err != nil {
				return nil, err
			}
			return int64(utf8.RuneCountInString(value)), nil
		}),
		fn("qt_v2_split_count", 2, func(a []driver.Value) (driver.Value, error) {
			value, err := text(a[0])
			if err != nil {
				return nil, err
			}
			separator, err := text(a[1])
			if err != nil {
				return nil, err
			}
			return int64(splitFormulaCount(value, separator)), nil
		}),
		fn("qt_v2_regex_test", 2, func(a []driver.Value) (driver.Value, error) {
			value, err := text(a[0])
			if err != nil {
				return nil, err
			}
			re, err := compile(a[1])
			if err != nil {
				return nil, err
			}
			if re.MatchString(value) {
				return int64(1), nil
			}
			return int64(0), nil
		}),
		fn("qt_v2_regex_extract", 3, func(a []driver.Value) (driver.Value, error) {
			value, err := text(a[0])
			if err != nil {
				return nil, err
			}
			re, err := compile(a[1])
			if err != nil {
				return nil, err
			}
			group, ok := a[2].(int64)
			if !ok || group < 0 || group > 100 {
				return nil, fmt.Errorf("invalid regex group")
			}
			if out, ok := extractFormulaRegex(re, value, int(group)); ok {
				return out, nil
			}
			return nil, nil
		}),
		fn("qt_v2_regex_replace", 3, func(a []driver.Value) (driver.Value, error) {
			out, code, err := replace(a)
			if err != nil || code != "" {
				return nil, err
			}
			return out, nil
		}),
		fn("qt_v2_regex_replace_error", 3, func(a []driver.Value) (driver.Value, error) {
			_, code, err := replace(a)
			if err != nil || code == "" {
				return nil, err
			}
			return code, nil
		}),
	}
}
