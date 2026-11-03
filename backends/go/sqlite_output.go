package querytable

import (
	"encoding/json"
	"fmt"
	"math"
	"time"
)

func sqliteOutput(v any, f FieldSpec) (any, error) {
	if v == nil {
		return nil, nil
	}
	switch f.Kind {
	case FieldNumber:
		var n float64
		switch value := v.(type) {
		case int64:
			n = float64(value)
		case float64:
			n = value
		default:
			return nil, fmt.Errorf("numeric binding has storage type %T", v)
		}
		if math.IsInf(n, 0) || math.IsNaN(n) {
			return nil, fmt.Errorf("numeric_range")
		}
		if math.Trunc(n) == n && math.Abs(n) > sqliteSafeInteger {
			return nil, fmt.Errorf("unsafe_integer")
		}
		return v, nil
	case FieldBool:
		if n, ok := v.(int64); ok && (n == 0 || n == 1) {
			return n == 1, nil
		}
		return nil, fmt.Errorf("boolean binding must contain 0, 1 or NULL")
	case FieldTextArray:
		var a []string
		s, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("textarray binding must be JSON text")
		}
		var raw []any
		if json.Unmarshal([]byte(s), &raw) != nil || raw == nil {
			return nil, fmt.Errorf("invalid JSON textarray")
		}
		for _, item := range raw {
			if _, ok := item.(string); !ok {
				return nil, fmt.Errorf("textarray must contain only strings")
			}
		}
		if err := json.Unmarshal([]byte(s), &a); err != nil {
			return nil, err
		}
		if a == nil {
			a = []string{}
		}
		return a, nil
	case FieldDatetime:
		var t time.Time
		switch f.SQLiteDatetimeFormat {
		case "unix-seconds", "unix-millis":
			scale := int64(1)
			if f.SQLiteDatetimeFormat == "unix-millis" {
				scale = 1000
			}
			var err error
			t, err = sqliteUnixTime(v, scale)
			if err != nil {
				return nil, err
			}

		default:
			s, ok := v.(string)
			if !ok {
				return nil, fmt.Errorf("datetime binding requires text storage")
			}
			if s == "" {
				return nil, nil
			}
			var e error
			t, e = sqliteParseTime(s)
			if e != nil {
				return nil, e
			}
			if f.SQLiteDatetimeFormat == "utc-millis" && s != t.UTC().Format("2006-01-02T15:04:05.000Z") {
				return nil, fmt.Errorf("utc-millis binding is not canonical")
			}
		}
		return t.UTC().Format(time.RFC3339Nano), nil
	case FieldText, FieldEnum:
		if s, ok := v.(string); ok {
			return s, nil
		}
		return nil, fmt.Errorf("text binding has storage type %T", v)
	}
	return v, nil
}
