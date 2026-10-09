package sqlitetests

import (
	"context"
	"errors"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func TestComputedSaveInValidation(t *testing.T) {
	db, d := setupV2(t)
	ctx := context.Background()
	if _, err := db.Exec(qt.SQLiteComputedColumnsDDL); err != nil {
		t.Fatal(err)
	}
	store := qt.SQLiteComputedColumnStore{DB: db}
	column := func(id, source string) qt.ComputedColumn {
		return qt.ComputedColumn{ID: id, Label: id, Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: source}}
	}
	// Validation is a host choice, and SaveIn works without a store-owned DB.
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	saved, err := (qt.SQLiteComputedColumnStore{}).SaveIn(ctx, tx, "one", "runs", qt.SaveComputedColumnRequest{Column: column("base", "[n]+1")})
	if err != nil || saved.Revision != "1" {
		t.Fatal(saved, err)
	}
	_, err = store.SaveIn(ctx, tx, "one", "runs", qt.SaveComputedColumnRequest{Column: column("child", "[@computed/base]+1")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = d.DescribeComputedIn(ctx, tx, []string{"base", "child"}, qt.PlanOptions{}); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{"SUM(", "[missing]", "[@computed/missing]", "[@computed/child]", `"text"`} {
		t.Run(source, func(t *testing.T) {
			tx, err := db.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			rev := "1"
			_, err = store.SaveIn(ctx, tx, "one", "runs", qt.SaveComputedColumnRequest{Column: column("base", source), ExpectedRevision: &rev})
			if err != nil {
				t.Fatal(err)
			}
			_, err = d.DescribeComputedIn(ctx, tx, []string{"base", "child"}, qt.PlanOptions{})
			var diagnostic *qt.PlanDiagnostic
			if !errors.As(err, &diagnostic) {
				t.Fatalf("invalid catalogue accepted: %v", err)
			}
			if err = tx.Rollback(); err != nil {
				t.Fatal(err)
			}
			list, err := store.List(ctx, "one", "runs")
			if err != nil || len(list) != 2 || list[0].Revision != "1" || list[0].Expression.Source != "[n]+1" {
				t.Fatal("invalid save persisted", list, err)
			}
		})
	}
	tx, err = db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	rev := "1"
	saved, err = store.SaveIn(ctx, tx, "one", "runs", qt.SaveComputedColumnRequest{Column: column("base", "[n]+2"), ExpectedRevision: &rev})
	if err != nil || saved.Revision != "2" {
		t.Fatal(saved, err)
	}
	if _, err = store.SaveIn(ctx, tx, "one", "runs", qt.SaveComputedColumnRequest{Column: column("base", "[n]+3"), ExpectedRevision: &rev}); !errors.Is(err, qt.ErrComputedConflict) {
		t.Fatal("stale update accepted", err)
	}
	if _, err = store.SaveIn(ctx, tx, "one", "runs", qt.SaveComputedColumnRequest{Column: column("base", "[n]+3")}); !errors.Is(err, qt.ErrComputedConflict) {
		t.Fatal("duplicate create accepted", err)
	}
	if _, err = d.DescribeComputedIn(ctx, tx, []string{"base", "child"}, qt.PlanOptions{}); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if _, err = store.SaveIn(ctx, nil, "one", "runs", qt.SaveComputedColumnRequest{Column: column("base", "1")}); err == nil {
		t.Fatal("nil transaction accepted")
	}
	list, err := store.List(ctx, "two", "runs")
	if err != nil || len(list) != 0 {
		t.Fatal("scope leaked", list, err)
	}
}
