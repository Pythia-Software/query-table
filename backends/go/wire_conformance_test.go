package querytable

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
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

// Error bodies decode into QueryErrorBody, carry a known code and re-marshal
// identically, the shape WriteQueryError writes.
func TestWireErrorFixturesRoundTrip(t *testing.T) {
	known := map[ErrorCode]bool{}
	for _, code := range ErrorCodes() {
		known[code] = true
	}
	for name, fixture := range wireFixtures(t, "errors") {
		t.Run(name, func(t *testing.T) {
			decoder := json.NewDecoder(bytes.NewReader(fixture))
			decoder.DisallowUnknownFields()
			var body QueryErrorBody
			if err := decoder.Decode(&body); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if !known[body.Error.Code] {
				t.Fatalf("unknown code %q", body.Error.Code)
			}
			got, err := marshalWire(body)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, fixture) {
				t.Fatalf("re-marshal differs\n got: %s\nwant: %s", got, fixture)
			}
			w := httptest.NewRecorder()
			WriteQueryError(w, &PlanDiagnostic{Code: body.Error.Code, Message: body.Error.Message, Field: body.Error.Field, Offset: body.Error.Offset, MetricID: body.Error.MetricID})
			if written := bytes.TrimSpace(w.Body.Bytes()); body.Error.Code != ErrorCodeInternal && !bytes.Equal(written, fixture) || w.Code != body.Error.Code.HTTPStatus() {
				t.Fatalf("WriteQueryError wrote %d %s", w.Code, written)
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

// A host's struct that embeds a wire type keeps its own fields, and the wire
// type still writes its required lists and maps when they are nil.
func TestWireTypesEmbedInHostStructs(t *testing.T) {
	data, err := json.Marshal(struct {
		QueryResultV3
		TraceID string `json:"traceId"`
	}{QueryResultV3{Version: 3}, "t1"})
	if err != nil || !strings.Contains(string(data), `"traceId":"t1"`) || !strings.Contains(string(data), `"rows":[]`) || !strings.Contains(string(data), `"metrics":[]`) {
		t.Fatalf("%s %v", data, err)
	}
	if data, _ = json.Marshal(ComputedExecution{}); !strings.Contains(string(data), `"resolvedRevisions":{}`) {
		t.Fatal(string(data))
	}
}
