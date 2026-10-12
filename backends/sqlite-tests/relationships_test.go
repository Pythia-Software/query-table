package sqlitetests

import (
	"context"
	"reflect"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func TestDiscoverForeignKeys(t *testing.T) {
	db, _ := setup(t)
	db.SetMaxOpenConns(1)
	_, err := db.Exec(`CREATE TABLE workspaces(tenant TEXT,id TEXT,PRIMARY KEY(tenant,id));
 CREATE TABLE calls(tenant TEXT,workspace TEXT,FOREIGN KEY(tenant,workspace) REFERENCES workspaces);
 CREATE TABLE labels(id TEXT PRIMARY KEY);
 CREATE TABLE explicit_refs(label TEXT REFERENCES labels(id));
 CREATE TABLE "odd'table"(label TEXT REFERENCES labels(id));`)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	keys, err := qt.DiscoverSQLiteForeignKeys(ctx, db, []string{"calls", "explicit_refs", "odd'table", "calls"})
	if err != nil {
		t.Fatal(err)
	}
	want := []qt.ForeignKey{
		{SourceTable: "calls", SourceColumns: []string{"tenant", "workspace"}, TargetTable: "workspaces", TargetColumns: []string{"tenant", "id"}},
		{SourceTable: "explicit_refs", SourceColumns: []string{"label"}, TargetTable: "labels", TargetColumns: []string{"id"}},
		{SourceTable: "odd'table", SourceColumns: []string{"label"}, TargetTable: "labels", TargetColumns: []string{"id"}},
	}
	if !reflect.DeepEqual(keys, want) {
		t.Fatalf("got %#v, want %#v", keys, want)
	}
	if _, err := qt.DiscoverSQLiteForeignKeys(ctx, db, []string{"calls'); DROP TABLE calls; --"}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("SELECT * FROM calls"); err != nil {
		t.Fatal(err)
	}
}
