package querytable

import (
	"context"
	"testing"
)

func TestProbeScratch(t *testing.T) {
	for _, test := range []struct{ kind, format string }{{"datetime", "unix-millis"}, {"datetime", "rfc3339"}, {"number", ""}} {
		doc := `{"name":"s","idField":"id","fields":[{"name":"id","type":"text","bindings":{"sqlite":{"expr":"r.id"}}},{"name":"label","type":"text","sort":{"field":"timestamp"},"bindings":{"sqlite":{"expr":"r.label"}}},{"name":"timestamp","type":"` + test.kind + `","bindings":{"sqlite":{"expr":"r.timestamp","datetimeFormat":"` + test.format + `"}}}]}`
		schema, _ := LoadSQLiteSchema([]byte(doc))
		p, err := compileTestSQLiteRows(WireQuery{Select: []string{"id"}, OrderBy: []OrderBy{{Field: "label", Dir: "asc"}}, Limit: 1}, schema)
		t.Log(err, p.SQL, p.Args)
	}
	sc := sqliteTestSchema()
	sc.DefaultSort = []OrderBy{{Field: "text", Dir: "asc", Extract: &RegexExtract{Regex: "(x)"}}}
	pp, err := compileTestSQLiteRows(WireQuery{Select: []string{"id"}, Where: []WhereTerm{{Field: "text", Op: "ends_with", Value: "zz"}}, Limit: 1}, sc)
	t.Log(err, pp.SQL, pp.Args)
	s := mustSchema(t)
	for _, n := range []string{"total_ms", "id"} {
		f := s.Fields[n]
		f.ExpressionNumeric = true
		s.Fields[n] = f
	}
	p, err := compileTestRows(context.Background(), WireQuery{Select: []string{"id"}, OrderBy: []OrderBy{{Field: "total_ms", Dir: "desc"}, {Field: "is_starred", Dir: "asc", Nulls: "first"}}, Limit: 1}, s, PlanOptions{SourceSQL: "SELECT * FROM runs r"})
	t.Log(p.Args)
	t.Log(err, p.SQL)
}
