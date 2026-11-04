package querytable

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The golden fixtures of schema/fixtures/wire are shared with the TypeScript
// and Swift suites. Go encodes in the schema's property order, so decoding a
// fixture and marshaling it again must reproduce it exactly.
func wireFixtures(t *testing.T, kind string) map[string][]byte {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join("..", "..", "schema", "fixtures", "wire", kind, "*.json"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("no %s fixtures: %v", kind, err)
	}
	out := map[string][]byte{}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var compact bytes.Buffer
		if err := json.Compact(&compact, data); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		out[filepath.Base(path)] = compact.Bytes()
	}
	return out
}

// marshalWire is json.Marshal without Go's HTML escaping of <, > and &
// (as \u-escapes), the only byte difference from the TypeScript and
// Swift encoders; both spellings are the same JSON string. Custom MarshalJSON
// methods escape internally, so the escapes are undone afterwards.
func marshalWire(v any) ([]byte, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return []byte(strings.NewReplacer("\\u003c", "<", "\\u003e", ">", "\\u0026", "&").Replace(string(data))), nil
}

func TestWireRequestFixturesRoundTrip(t *testing.T) {
	for name, fixture := range wireFixtures(t, "requests") {
		t.Run(name, func(t *testing.T) {
			request, err := DecodeQueryRequestV3(fixture)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			got, err := marshalWire(request)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, fixture) {
				t.Fatalf("re-marshal differs\n got: %s\nwant: %s", got, fixture)
			}
		})
	}
}

func TestWireResultFixturesRoundTrip(t *testing.T) {
	for name, fixture := range wireFixtures(t, "results") {
		t.Run(name, func(t *testing.T) {
			decoder := json.NewDecoder(bytes.NewReader(fixture))
			decoder.DisallowUnknownFields()
			var result QueryResultV3
			if err := decoder.Decode(&result); err != nil {
				t.Fatalf("decode: %v", err)
			}
			got, err := marshalWire(result)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, fixture) {
				t.Fatalf("re-marshal differs\n got: %s\nwant: %s", got, fixture)
			}
		})
	}
}

// Required arrays stay arrays when a Go caller leaves them nil.
func TestWireGroupingEmptyArrays(t *testing.T) {
	data, err := json.Marshal(GroupingDefinition{})
	if err != nil || string(data) != `{"keys":[],"summaries":[],"representative":null}` {
		t.Fatalf("%s %v", data, err)
	}
	var back GroupingDefinition
	if err = json.Unmarshal([]byte(`{"keys":["k"],"summaries":[],"representative":null}`), &back); err != nil || len(back.Summaries) != 0 {
		t.Fatalf("%#v %v", back, err)
	}
	if data, _ = json.Marshal(GroupingDefinition{Keys: []string{"k"}}); string(data) != `{"keys":["k"],"summaries":[],"representative":null}` {
		t.Fatal(string(data))
	}
}
