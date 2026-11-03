package querytable

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// Loads the shipped example document through the real backend loader, so the
// example, the meta-schema, and LoadSchema can never silently drift.
func TestExampleSchemaLoads(t *testing.T) {
	path := filepath.Join("..", "..", "schema", "examples", "runs.schema.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read example: %v", err)
	}
	s, err := LoadSchema(raw)
	if err != nil {
		t.Fatalf("LoadSchema(example): %v", err)
	}
	if s.Name != "runs" || s.IDField != "id" {
		t.Errorf("name/id = %q/%q", s.Name, s.IDField)
	}
	// `details` is a derived field (no postgres binding) → absent from backend schema.
	if _, ok := s.Fields["details"]; ok {
		t.Error("derived field details should not be in the backend schema")
	}
	// `error_codes` has filter.pushdown:false → not server-filterable.
	if s.Fields["error_codes"].ServerFilter {
		t.Error("error_codes should be client-only (pushdown:false)")
	}
	// `is_starred` is synthetic and sorts via its own expr.
	star, ok := s.Fields["is_starred"]
	if !ok || !star.Synthetic {
		t.Errorf("is_starred missing/!synthetic: %+v", star)
	}
	// tiebreak carries through.
	if len(s.TiebreakSort) != 1 || s.TiebreakSort[0].Field != "id" {
		t.Errorf("tiebreak = %+v", s.TiebreakSort)
	}

	// And it actually compiles a representative v3 row page. The example does
	// not opt its numeric bindings into the bounded expression profile, which
	// v3 needs to sort typed numbers; a host sets expressionNumeric for that.
	for _, name := range []string{"id", "total_ms"} {
		f := s.Fields[name]
		f.ExpressionNumeric = true
		s.Fields[name] = f
	}
	q := WireQuery{
		Select:  []string{"overall", "is_starred"},
		Where:   []WhereTerm{{Field: "overall", Op: "=", Value: "FAIL"}},
		OrderBy: []OrderBy{{Field: "total_ms", Dir: "desc"}},
		Limit:   50,
	}
	if _, err := compileTestRows(context.Background(), q, s, PlanOptions{SourceSQL: "SELECT * FROM runs r"}); err != nil {
		t.Fatalf("Compile against example: %v", err)
	}
}
