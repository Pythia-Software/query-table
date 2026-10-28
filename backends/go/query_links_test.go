package querytable

import (
	"bytes"
	"compress/flate"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Parity with @pythia-software/query-table-core. The TypeScript test
// packages/core/test/queryLinkFixtures.test.ts writes query-links.json; this
// file decodes it and writes the tokens EncodeQueryLink produces to
// query-links-go.json, which the TypeScript test decodes in turn. Regenerate
// that file with UPDATE_QUERY_LINK_FIXTURES=1 go test -run TestQueryLinkFixtures.
const (
	queryLinkFixturePath   = "../../schema/fixtures/query-links.json"
	queryLinkGoTokensPath  = "../../schema/fixtures/query-links-go.json"
	queryLinkUpdateFixture = "UPDATE_QUERY_LINK_FIXTURES"
)

type queryLinkFixture struct {
	Valid []struct {
		Name       string          `json:"name"`
		State      json.RawMessage `json:"state"`
		Token      string          `json:"token"`
		Normalized json.RawMessage `json:"normalized"`
		Packed     string          `json:"packed"`
	} `json:"valid"`
	Invalid []struct {
		Name  string          `json:"name"`
		Token json.RawMessage `json:"token"`
		Code  string          `json:"code"`
	} `json:"invalid"`
	EncodeInvalid []struct {
		Name  string          `json:"name"`
		State json.RawMessage `json:"state"`
		Code  string          `json:"code"`
	} `json:"encodeInvalid"`
}

func loadQueryLinkFixture(t testing.TB) queryLinkFixture {
	t.Helper()
	data, err := os.ReadFile(queryLinkFixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var fixture queryLinkFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Valid) == 0 || len(fixture.Invalid) == 0 || len(fixture.EncodeInvalid) == 0 {
		t.Fatal("query link fixture is empty")
	}
	return fixture
}

// canonicalJS is JSON.stringify(JSON.parse(raw)).
func canonicalJS(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	value, err := parseJSValue(string(raw))
	if err != nil {
		t.Fatalf("fixture JSON: %v", err)
	}
	return stringifyJS(value)
}

// tokenPayload is the JSON text a token carries, before compression.
func tokenPayload(t *testing.T, token string) string {
	t.Helper()
	data, err := base64.RawURLEncoding.DecodeString(token[3:])
	if err != nil {
		t.Fatalf("token %q: %v", token, err)
	}
	if strings.HasPrefix(token, "2d.") {
		if data, err = io.ReadAll(flate.NewReader(bytes.NewReader(data))); err != nil {
			t.Fatalf("token %q: %v", token, err)
		}
	}
	return string(data)
}

func linkQueryState(t *testing.T, q LinkQuery) string {
	t.Helper()
	state, err := q.jsState()
	if err != nil {
		t.Fatal(err)
	}
	return stringifyJS(state)
}

const generatorAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

// expandGenerators mirrors expandGenerators in queryLinkCases.ts.
func expandGenerators(v *jsValue) *jsValue {
	switch {
	case v.isArray():
		out := jsArr()
		for _, item := range v.a {
			out.a = append(out.a, expandGenerators(item))
		}
		return out
	case !v.isRecord():
		return v
	case v.get("$repeat").isString():
		return jsStr(strings.Repeat(v.get("$repeat").s, int(v.get("count").n)))
	case v.get("$random").isNumber():
		x := uint32(v.get("$random").n)
		if x == 0 {
			x = 1
		}
		out := make([]byte, int(v.get("length").n))
		for i := range out {
			x ^= x << 13
			x ^= x >> 17
			x ^= x << 5
			out[i] = generatorAlphabet[x&63]
		}
		return jsStr(string(out))
	}
	out := jsObj()
	for _, key := range v.o.keys() {
		out.set(key, expandGenerators(v.o.values[key]))
	}
	return out
}

func linkQueryFromFixture(t *testing.T, raw json.RawMessage) LinkQuery {
	t.Helper()
	value, err := parseJSValue(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	var q LinkQuery
	if err := json.Unmarshal([]byte(stringifyJS(expandGenerators(value))), &q); err != nil {
		t.Fatal(err)
	}
	return q
}

func linkErrorCode(err error) string {
	var linkErr *QueryLinkError
	if errors.As(err, &linkErr) {
		return string(linkErr.Code)
	}
	return ""
}

func TestQueryLinkFixtures(t *testing.T) {
	fixture := loadQueryLinkFixture(t)
	goTokens := map[string]string{}
	for _, c := range fixture.Valid {
		want := canonicalJS(t, c.Normalized)
		decoded, err := DecodeQueryLink(c.Token)
		if err != nil {
			t.Errorf("%s: decode: %v", c.Name, err)
			continue
		}
		if got := linkQueryState(t, decoded); got != want {
			t.Errorf("%s: decoded state\n got %s\nwant %s", c.Name, got, want)
		}
		token, err := EncodeQueryLink(decoded)
		if err != nil {
			t.Errorf("%s: re-encode: %v", c.Name, err)
			continue
		}
		if got := tokenPayload(t, token); got != c.Packed {
			t.Errorf("%s: re-encoded JSON\n got %s\nwant %s", c.Name, got, c.Packed)
		}
		// The Go token reads back as the TypeScript token for the decoded
		// state would (not always as `want`: see the TypeScript test).
		again, err := DecodeQueryLink(token)
		reference, referenceErr := DecodeQueryLink("2j." + base64.RawURLEncoding.EncodeToString([]byte(c.Packed)))
		if err != nil || referenceErr != nil || linkQueryState(t, again) != linkQueryState(t, reference) {
			t.Errorf("%s: decoding the Go token: %v, %v", c.Name, err, referenceErr)
		}
		goTokens[c.Name] = token
		if len(c.State) == 0 {
			continue
		}
		// Encoding the original state writes exactly what encodeQuery wrote.
		direct, err := EncodeQueryLink(linkQueryFromFixture(t, c.State))
		if err != nil {
			t.Errorf("%s: encode: %v", c.Name, err)
		} else if got, want := tokenPayload(t, direct), tokenPayload(t, c.Token); got != want {
			t.Errorf("%s: encoded JSON\n got %s\nwant %s", c.Name, got, want)
		}
	}
	if t.Failed() {
		return
	}
	if os.Getenv(queryLinkUpdateFixture) == "1" {
		data, err := json.MarshalIndent(map[string]any{"tokens": goTokens}, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(queryLinkGoTokensPath, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(queryLinkGoTokensPath)
	if err != nil {
		t.Fatal(err)
	}
	var stored struct {
		Tokens map[string]string `json:"tokens"`
	}
	if err := json.Unmarshal(data, &stored); err != nil {
		t.Fatal(err)
	}
	var names, storedNames []string
	for name := range goTokens {
		names = append(names, name)
	}
	for name := range stored.Tokens {
		storedNames = append(storedNames, name)
	}
	sort.Strings(names)
	sort.Strings(storedNames)
	if strings.Join(names, "\n") != strings.Join(storedNames, "\n") {
		t.Fatalf("%s lists other cases; rerun with %s=1", queryLinkGoTokensPath, queryLinkUpdateFixture)
	}
	for name, token := range goTokens {
		if tokenPayload(t, stored.Tokens[name]) != tokenPayload(t, token) {
			t.Errorf("%s: stored Go token is stale; rerun with %s=1", name, queryLinkUpdateFixture)
		}
	}
}

func TestQueryLinkFixturesInvalid(t *testing.T) {
	for _, c := range loadQueryLinkFixture(t).Invalid {
		var token string
		if err := json.Unmarshal(c.Token, &token); err != nil {
			var generated struct {
				Prefix string `json:"prefix"`
				Repeat string `json:"repeat"`
				Count  int    `json:"count"`
			}
			if err := json.Unmarshal(c.Token, &generated); err != nil {
				t.Fatal(err)
			}
			token = generated.Prefix + strings.Repeat(generated.Repeat, generated.Count)
		}
		_, err := DecodeQueryLink(token)
		if got := linkErrorCode(err); got != c.Code {
			t.Errorf("%s: got %q (%v), want %q", c.Name, got, err, c.Code)
		}
	}
}

func TestQueryLinkFixturesEncodeInvalid(t *testing.T) {
	for _, c := range loadQueryLinkFixture(t).EncodeInvalid {
		_, err := EncodeQueryLink(linkQueryFromFixture(t, c.State))
		if got := linkErrorCode(err); got != c.Code {
			t.Errorf("%s: got %q (%v), want %q", c.Name, got, err, c.Code)
		}
	}
}

func TestEncodeQueryLinkRejectsWhatStrictDecodingRejects(t *testing.T) {
	predicates := make([]WhereTerm, 101)
	for i := range predicates {
		predicates[i] = WhereTerm{Field: "n", Op: "=", Value: "1"}
	}
	for name, q := range map[string]LinkQuery{
		"unknown operator":  {Where: []WhereTerm{{Field: "a", Op: "like", Value: "x"}}},
		"empty field":       {Where: []WhereTerm{{Op: "=", Value: "x"}}},
		"group member":      {Where: []WhereTerm{{Any: []WhereClause{{Field: "a", Op: "=", Value: "1"}, {Field: "b", Op: "?"}}}}},
		"predicate budget":  {Where: predicates},
		"empty OR group":    {Where: []WhereTerm{{Field: "a", Op: "=", Value: "1"}, {Any: []WhereClause{}}}},
		"metric without id": {Aggregations: []json.RawMessage{json.RawMessage(`{"op":"count","groupBy":[]}`)}},
		"metric JSON":       {Aggregations: []json.RawMessage{json.RawMessage(`{`)}},
		"grouping JSON":     {Grouping: json.RawMessage(`[`)},
		"column display":    {Select: []LinkColumn{{Field: "a", Display: json.RawMessage(`{"kind":`)}}},
		"item details JSON": {ItemDetails: json.RawMessage(`nul`)},
	} {
		if _, err := EncodeQueryLink(q); linkErrorCode(err) != string(QueryLinkInvalid) {
			t.Errorf("%s: got %v, want an invalid error", name, err)
		}
	}
}

func TestQueryLinkDashboardFilter(t *testing.T) {
	q := LinkQuery{Where: []WhereTerm{
		{Field: "provider", Op: "=", Value: "anthropic"},
		{Field: "model_family", Op: "contains", Value: "opus"},
	}}
	token, err := EncodeQueryLink(q)
	if err != nil {
		t.Fatal(err)
	}
	if got := tokenPayload(t, token); got != `{"w":[{"field":"provider","op":"=","value":"anthropic"},{"field":"model_family","op":"contains","value":"opus"}]}` {
		t.Fatalf("payload %s", got)
	}
	decoded, err := DecodeQueryLink(token)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Limit != 100 || len(decoded.Where) != 2 || !reflect.DeepEqual(decoded.Where[1], WhereTerm{Field: "model_family", Op: "contains", Value: "opus"}) {
		t.Fatalf("decoded %+v", decoded)
	}
}

// normalizeQueryState keeps a set filter whose mode only stringifies to a
// valid one, which encodeQuery then cannot encode. LinkQuery cannot hold it.
func TestDecodeQueryLinkRejectsNonStringSetMode(t *testing.T) {
	token := "2j." + base64.RawURLEncoding.EncodeToString([]byte(`{"w":[{"field":"tags","op":"includes","value":"a","setFilter":{"id":"x","mode":["any"],"values":["a"]}}]}`))
	if _, err := DecodeQueryLink(token); linkErrorCode(err) != string(QueryLinkInvalid) {
		t.Fatalf("got %v", err)
	}
}

func TestFormatJSNumber(t *testing.T) {
	for n, want := range map[float64]string{
		1e21: "1e+21", 1e-7: "1e-7", 123.456: "123.456", 5e-324: "5e-324", 9007199254740992: "9007199254740992",
		1.5e300: "1.5e+300", 0.000001: "0.000001", 123456789012345680000: "123456789012345680000", -2.5: "-2.5",
	} {
		if got := formatJSNumber(n); got != want {
			t.Errorf("%v: got %s, want %s", n, got, want)
		}
	}
	if got := stringifyJS(jsNum(math.Copysign(0, -1))); got != "0" {
		t.Errorf("-0: got %s", got)
	}
}

// Any link payload either fails with a QueryLinkError or decodes to a state
// that encodes again. `go test -fuzz FuzzDecodeQueryLink` explores beyond the
// seeds; it fuzzes the JSON inside a "2j." token, where normalization lives.
func FuzzDecodeQueryLink(f *testing.F) {
	for _, c := range loadQueryLinkFixture(f).Valid {
		f.Add(c.Packed)
	}
	f.Fuzz(func(t *testing.T, payload string) {
		q, err := DecodeQueryLink("2j." + base64.RawURLEncoding.EncodeToString([]byte(payload)))
		if err != nil {
			if linkErrorCode(err) == "" {
				t.Fatalf("untyped error %v", err)
			}
			return
		}
		again, err := EncodeQueryLink(q)
		if err != nil {
			if linkErrorCode(err) != string(QueryLinkTooLarge) {
				t.Fatalf("decoded state does not encode: %v", err)
			}
			return
		}
		if _, err := DecodeQueryLink(again); err != nil {
			t.Fatalf("re-encoded token does not decode: %v", err)
		}
	})
}

// Inserting array-index keys used to cost O(n) each. A link near the token
// limit with hundreds of thousands of them must still decode quickly, both
// where normalization ignores it and where it keeps and re-encodes it.
func TestDecodeQueryLinkManyIndexKeysIsLinear(t *testing.T) {
	const keys = 200_000
	members := func(descending bool) string {
		var b strings.Builder
		b.WriteByte('{')
		for i := 0; i < keys; i++ {
			n := i
			if descending {
				n = keys - 1 - i
			}
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(`"` + strconv.Itoa(n) + `":"v"`)
		}
		b.WriteString(`,"name":"v"}`)
		return b.String()
	}
	deflate := func(text string) string {
		var buf bytes.Buffer
		w, _ := flate.NewWriter(&buf, flate.BestCompression)
		w.Write([]byte(text))
		w.Close()
		return "2d." + base64.RawURLEncoding.EncodeToString(buf.Bytes())
	}
	for name, payload := range map[string]string{
		"ignored ascending":  `{"z":` + members(false) + `}`,
		"ignored descending": `{"z":` + members(true) + `}`,
		"kept chip labels":   `{"s":[["a",null,{"kind":"chip","labels":` + members(true) + `}]]}`,
	} {
		token := deflate(payload)
		if len(token) > MaxQueryTokenLength {
			t.Fatalf("%s: token too long", name)
		}
		start := time.Now()
		q, err := DecodeQueryLink(token)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if _, err := EncodeQueryLink(q); err != nil && linkErrorCode(err) != string(QueryLinkTooLarge) {
			t.Fatalf("%s: re-encode: %v", name, err)
		}
		elapsed := time.Since(start)
		t.Logf("%s: %d-byte token decoded and re-encoded in %v", name, len(token), elapsed)
		if elapsed > 10*time.Second {
			t.Errorf("%s took %v", name, elapsed)
		}
	}
}
