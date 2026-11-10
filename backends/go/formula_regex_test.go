package querytable

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// The browser's results for each pattern are in the shared fixture; the
// server must reproduce them exactly or refuse the pattern for that function.
func TestFormulaRegexMatchesBrowserFixture(t *testing.T) {
	data, err := os.ReadFile("../../schema/fixtures/formula-regex.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Inputs []string `json:"inputs"`
		Cases  []struct {
			Pattern     string   `json:"pattern"`
			Flags       string   `json:"flags"`
			Replacement string   `json:"replacement"`
			Group       int      `json:"group"`
			Refused     []string `json:"refused"`
			Results     []struct {
				Test    bool `json:"test"`
				Extract any  `json:"extract"`
				Replace any  `json:"replace"`
			} `json:"results"`
		} `json:"cases"`
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, c := range fixture.Cases {
		for _, function := range []string{"test", "extract", "replace"} {
			re, err := formulaRegexFor("REGEX_"+strings.ToUpper(function), c.Pattern, c.Flags)
			if slices.Contains(c.Refused, function) {
				var d *PlanDiagnostic
				if !errors.As(err, &d) || d.Code != ErrorCodeUnsupportedRegex {
					t.Errorf("%s /%s/%s: want a refusal, got %v", function, c.Pattern, c.Flags, err)
				}
				continue
			}
			if err != nil {
				t.Errorf("%s /%s/%s: %v", function, c.Pattern, c.Flags, err)
				continue
			}
			compiled := regexp.MustCompile(re.re2)
			for i, input := range fixture.Inputs {
				want := c.Results[i]
				var got any
				switch function {
				case "test":
					got, want := compiled.MatchString(input), want.Test
					if got != want {
						t.Errorf("test /%s/%s on %q: got %v, want %v", c.Pattern, c.Flags, input, got, want)
					}
					continue
				case "extract":
					if out, ok := extractFormulaRegex(compiled, input, c.Group); ok {
						got = out
					}
					if !reflect.DeepEqual(got, want.Extract) {
						t.Errorf("extract /%s/%s group %d on %q: got %#v, want %#v", c.Pattern, c.Flags, c.Group, input, got, want.Extract)
					}
				case "replace":
					out, code := replaceFormulaRegex(compiled, input, c.Replacement)
					got = out
					if code != "" {
						got = map[string]any{"error": true}
					}
					if !reflect.DeepEqual(got, want.Replace) {
						t.Errorf("replace /%s/%s with %q on %q: got %#v, want %#v", c.Pattern, c.Flags, c.Replacement, input, got, want.Replace)
					}
				}
			}
		}
	}
}

func TestFormulaSplitCountMatchesStringSplit(t *testing.T) {
	for _, c := range []struct {
		value, separator string
		want             int
	}{
		{"", ",", 1}, {"", "", 0}, {"a,,b", ",", 3}, {"aaa", "aa", 2}, {"a", "a", 2},
		{"\U0001F600x", "", 3}, {"é", "", 2}, {"a\U0001F600b\U0001F600", "\U0001F600", 3},
	} {
		if got := splitFormulaCount(c.value, c.separator); got != c.want {
			t.Errorf("%q.split(%q): got %d, want %d", c.value, c.separator, got, c.want)
		}
	}
}
