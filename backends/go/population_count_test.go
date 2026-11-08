package querytable

import (
	"database/sql/driver"
	"strings"
	"testing"
	"time"
)

type keyedValuer struct{ v string }

func (k keyedValuer) Value() (driver.Value, error) { return k.v, nil }

func TestPopulationKeyArguments(t *testing.T) {
	d := QueryDatasetV3{Dialect: "sqlite", Scope: "s", Dataset: "d"}
	key := func(args ...any) string {
		return populationKey(d, SQLPlan{SQL: "SELECT COUNT(*) FROM t WHERE a=?1", Args: args, Profile: "p"}, PlanOptions{})
	}
	s, n := "x", int64(3)
	at := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	for name, pair := range map[string][2]any{
		"pointer":      {&s, "x"},
		"int width":    {int32(3), &n},
		"valuer":       {keyedValuer{"x"}, "x"},
		"same instant": {at, at.Add(0)},
		"nil pointer":  {(*string)(nil), nil},
		"copied bytes": {[]byte("x"), []byte("x")},
	} {
		if key(pair[0]) != key(pair[1]) {
			t.Errorf("%s: equal bound values keyed apart", name)
		}
	}
	for name, pair := range map[string][2]any{
		"string vs bytes": {"x", []byte("x")},
		"int vs float":    {int64(1), float64(1)},
		"text vs number":  {"1", int64(1)},
		"offset":          {at, at.In(time.FixedZone("x", 3600))},
		"string boundary": {"a\x00b", "a"},
	} {
		if key(pair[0]) == key(pair[1]) {
			t.Errorf("%s: different bound values share a key", name)
		}
	}
	if key("a", "b") == key("a\x00string:\"b\"") {
		t.Error("argument boundaries are ambiguous")
	}
	// A type only its driver understands never shares a key.
	type opaque struct{ v string }
	first, second := key(opaque{"x"}), key(opaque{"x"})
	if first == second || !strings.HasPrefix(first, "unique-") {
		t.Errorf("unconvertible argument keys %q %q", first, second)
	}
}

func TestCloneArgument(t *testing.T) {
	s := "x"
	b := []byte("ab")
	nested := []any{&s, b, map[string][]byte{"k": []byte("v")}, [1]*string{&s}}
	c := cloneArgument(nested).([]any)
	*c[0].(*string) = "y"
	c[1].([]byte)[0] = 'z'
	c[2].(map[string][]byte)["k"][0] = 'w'
	*c[3].([1]*string)[0] = "y"
	if s != "x" || string(b) != "ab" || string(nested[2].(map[string][]byte)["k"]) != "v" {
		t.Fatalf("clone shares state: %q %q %v", s, b, nested[2])
	}
	if cloneArgument(nil) != nil || cloneArgument([]byte(nil)).([]byte) != nil {
		t.Fatal("nil arguments must stay nil")
	}
	if got := cloneArgument(keyedValuer{"v"}); got != (keyedValuer{"v"}) {
		t.Fatalf("struct argument %v", got)
	}
}
