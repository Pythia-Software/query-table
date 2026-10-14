package sqlitetests

import (
	"context"
	"database/sql"
	"errors"
	qt "github.com/Pythia-Software/query-table/backends/go"
	"testing"
)

func TestQuerySnapshotsAreDurableImmutableAndScoped(t *testing.T) {
	db, _ := setupV2(t)
	if _, err := db.Exec(qt.QuerySnapshotsDDL); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	store := qt.SQLQuerySnapshotStore{DB: db}
	snapshot := qt.QuerySnapshot{Version: 1, Code: "aaaaaaaaaaaaaaaaaaaaaa", Token: "2j.e30"}
	saved, err := store.Save(ctx, "tenant", "runs", snapshot)
	if err != nil || saved.CreatedAt <= 0 {
		t.Fatal(saved, err)
	}
	again, err := (qt.SQLQuerySnapshotStore{DB: db}).Resolve(ctx, "tenant", "runs", snapshot.Code)
	if err != nil || saved != again {
		t.Fatal(again, err)
	}
	same, err := store.Save(ctx, "tenant", "runs", snapshot)
	if err != nil || same != saved {
		t.Fatal(same, err)
	}
	snapshot.Token = "2j.eyJsIjoyNX0"
	if _, err = store.Save(ctx, "tenant", "runs", snapshot); !errors.Is(err, qt.ErrQuerySnapshotConflict) {
		t.Fatal(err)
	}
	for _, scope := range []string{"other", ""} {
		if _, err = store.Resolve(ctx, scope, "runs", snapshot.Code); !errors.Is(err, sql.ErrNoRows) {
			t.Fatal(err)
		}
	}
	if _, err = store.Resolve(ctx, "tenant", "other", snapshot.Code); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal(err)
	}
}

func TestQuerySnapshotHostTransaction(t *testing.T) {
	db, _ := setupV2(t)
	if _, err := db.Exec(qt.QuerySnapshotsDDL); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	store := qt.SQLQuerySnapshotStore{DB: db}
	snapshot := qt.QuerySnapshot{Version: 1, Code: "aaaaaaaaaaaaaaaaaaaaaa", Token: "2j.e30", CreatedAt: -1}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := store.SaveIn(ctx, tx, "tenant", "runs", snapshot)
	if err != nil || saved.CreatedAt <= 0 {
		t.Fatal(saved, err)
	}
	if same, err := store.ResolveIn(ctx, tx, "tenant", "runs", snapshot.Code); err != nil || same != saved {
		t.Fatal(same, err)
	}
	if same, err := store.SaveIn(ctx, tx, "tenant", "runs", snapshot); err != nil || same != saved {
		t.Fatal(same, err)
	}
	changed := snapshot
	changed.Token = "2j.eyJsIjoyNX0"
	if _, err := store.SaveIn(ctx, tx, "tenant", "runs", changed); !errors.Is(err, qt.ErrQuerySnapshotConflict) {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Resolve(ctx, "tenant", "runs", snapshot.Code); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("rollback persisted snapshot:", err)
	}
	tx, err = db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for _, token := range []string{"2j.bnVsbA", "3j.e30", "2d.AA"} {
		invalid := snapshot
		invalid.Token = token
		if _, err := store.SaveIn(ctx, tx, "tenant", "runs", invalid); err == nil {
			t.Fatal("invalid direct write accepted:", token)
		}
	}
	if _, err := store.SaveIn(ctx, tx, "tenant", "runs", snapshot); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Resolve(ctx, "tenant", "runs", snapshot.Code); err != nil {
		t.Fatal("committed snapshot missing:", err)
	}
}
