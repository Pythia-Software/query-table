package querytable

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestDecodeQueryRequestV3Distinct(t *testing.T) {
	body := `{"version":3,"profile":"p","now":1,"source":{"where":[{"field":"k","op":"=","value":"a"}]},"result":{"limit":1},"rows":false,"metrics":[],"hostState":{"tenant":"one"},"distinct":{"field":"k","search":"ab","limit":50}}`
	q, err := DecodeQueryRequestV3([]byte(body))
	if err != nil || q.Distinct == nil || *q.Distinct != (DistinctRequestV3{"k", "ab", 50}) || string(q.HostState) != `{"tenant":"one"}` || len(q.Source.Where) != 1 {
		t.Fatalf("%#v %v", q, err)
	}
	var diag *PlanDiagnostic
	for name, replace := range map[string][2]string{
		"rows":          {`"rows":false`, `"rows":true`},
		"metrics":       {`"metrics":[]`, `"metrics":[{"id":"n","op":"count"}]`},
		"grouping":      {`"rows":false`, `"rows":false,"grouping":{"keys":["k"],"summaries":[]}`},
		"zero limit":    {`"limit":50`, `"limit":0`},
		"large limit":   {`"limit":50`, `"limit":501`},
		"missing field": {`"field":"k","search"`, `"field":"","search"`},
		"long search":   {`"search":"ab"`, `"search":"` + strings.Repeat("é", 2001) + `"`},
		"array host":    {`{"tenant":"one"}`, `["one"]`},
		"null host":     {`{"tenant":"one"}`, `null`},
	} {
		if _, err := DecodeQueryRequestV3([]byte(strings.Replace(body, replace[0], replace[1], 1))); !errors.As(err, &diag) || diag.Code != "query" {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := DecodeQueryRequestV3([]byte(strings.Replace(body, `"limit":50`, `"limit":50,"values":[]`, 1))); err == nil {
		t.Error("unknown distinct property accepted")
	}
	if _, err := DecodeQueryRequestV3([]byte(strings.Replace(body, `"search":"ab"`, `"search":"`+strings.Repeat("é", 2000)+`"`, 1))); err != nil {
		t.Error("2000-character search rejected", err)
	}
	out, _ := json.Marshal(QueryResultV3{Distinct: &DistinctResultV3{Values: []string{"a"}, HasNull: true}})
	if !strings.Contains(string(out), `"distinct":{"values":["a"],"hasMore":false,"hasNull":true}`) {
		t.Fatal(string(out))
	}
	if out, _ = json.Marshal(QueryResultV3{}); strings.Contains(string(out), "distinct") {
		t.Fatal(string(out))
	}
}
