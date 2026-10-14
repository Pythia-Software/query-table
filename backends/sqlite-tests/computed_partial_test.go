package sqlitetests

import (
	"context"
	"errors"
	qt "github.com/Pythia-Software/query-table/backends/go"
	"testing"
)

func TestComputedPartialDescription(t *testing.T) {
	db, d := setupV2(t)
	if _, err := db.Exec(qt.SQLiteComputedColumnsDDL); err != nil {
		t.Fatal(err)
	}
	for id, source := range map[string]string{"base": "[n]+1", "child": "[@computed/base]*2", "syntax": "SUM(", "removed": "[gone]", "missing": "[@computed/gone]", "cycle_a": "[@computed/cycle_b]", "cycle_b": "[@computed/cycle_a]"} {
		_, err := db.Exec(`INSERT INTO query_table_computed_columns(scope,dataset,id,label,language,language_version,source,revision,updated_at) VALUES('one','runs',?,?,'qt-expr',1,?,1,0)`, id, id, source)
		if err != nil {
			t.Fatal(err)
		}
	}
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	ids := []string{"child", "syntax", "removed", "missing", "cycle_a", "cycle_b"}
	description, err := d.DescribeComputedPartialIn(context.Background(), tx, ids, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(description.Execution.Fields) != 1 || len(description.Execution.ResolvedRevisions) != 2 || len(description.Diagnostics) != 5 {
		t.Fatal(description)
	}
	if description.Execution.ResolvedRevisions["base"] != "1" || description.Execution.Fields["@computed/child"].Type != "number" {
		t.Fatal(description)
	}
	if _, err = d.DescribeComputedIn(context.Background(), tx, ids, qt.PlanOptions{}); err == nil {
		t.Fatal("legacy all-or-error API changed")
	}
	outage := errors.New("catalogue unavailable")
	if _, err = d.DescribeComputedPartialIn(context.Background(), tx, []string{"child"}, qt.PlanOptions{Resolver: qt.DefinitionResolverFunc(func(context.Context, string) (qt.ComputedColumn, error) { return qt.ComputedColumn{}, outage })}); !errors.Is(err, outage) {
		t.Fatal("infrastructure failure hidden", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = d.DescribeComputedPartialIn(ctx, tx, ids, qt.PlanOptions{}); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	v3 := qt.QueryDatasetV3{Schema: d.Schema, SourceSQL: d.SourceSQL, SourceArgs: d.SourceArgs, Scope: "one", Dataset: "runs", Dialect: "sqlite", ComputedGroupable: map[string]bool{"child": true}, ComputedFilterable: map[string]bool{"child": true}}
	current, err := v3.DescribeComputedPartialIn(context.Background(), tx, ids, qt.PlanOptions{})
	if err != nil || !current.Execution.Fields["@computed/child"].Filter || !current.Execution.Fields["@computed/child"].Group {
		t.Fatal(current, err)
	}
}
