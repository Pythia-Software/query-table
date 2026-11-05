package postgrestests

import (
	"context"
	"errors"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// PostgreSQL advertises regexSourceFilters: false and regex: false, so it must
// refuse regex filters and regex sorting itself rather than rely on clients.
func TestPostgresRefusesUnadvertisedCapabilities(t *testing.T) {
	db, d := fixture(t)
	if caps := d.Capabilities(); caps.RegexSourceFilters || caps.Regex || caps.ComputedSourceFilters {
		t.Fatal("unexpected capabilities", caps)
	}
	for name, modify := range map[string]func(*qt.QueryRequestV3){
		"regex source filter": func(q *qt.QueryRequestV3) {
			q.Source.Where = []qt.WhereTerm{{Field: "label", Op: "matches_regex", Value: "^t"}}
		},
		"regex result filter": func(q *qt.QueryRequestV3) {
			q.Grouping = nil
			q.Result = qt.WireQuery{Select: []string{"id"}, Where: []qt.WhereTerm{{Field: "label", Op: "not_matches_regex", Value: "^t"}}, Limit: 10}
			q.Source = q.Result
		},
		"regex sort": func(q *qt.QueryRequestV3) {
			q.Grouping = nil
			q.Result = qt.WireQuery{Select: []string{"id"}, OrderBy: []qt.OrderBy{{Field: "label", Dir: "asc", Extract: &qt.RegexExtract{Regex: "(a)"}}}, Limit: 10}
			q.Source = q.Result
		},
	} {
		q := groupedQuery()
		modify(&q)
		var issue *qt.PlanDiagnostic
		if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); !errors.As(err, &issue) || issue.Code != qt.ErrorCodeUnsupportedRegex {
			t.Errorf("%s: %v", name, err)
		}
	}
}
