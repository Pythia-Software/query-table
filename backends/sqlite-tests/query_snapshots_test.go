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
