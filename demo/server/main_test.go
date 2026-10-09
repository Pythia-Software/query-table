package main

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestDelayHeader(t *testing.T) {
	for _, value := range []string{"-1", "5001", "1.5", "invalid"} {
		r := httptest.NewRequest("POST", "/", nil)
		r.Header.Set("X-Demo-DB-Delay", value)
		if _, err := delayHeader(r, "X-Demo-DB-Delay"); err == nil {
			t.Errorf("accepted %q", value)
		}
	}
	r := httptest.NewRequest("POST", "/", nil)
	r.Header.Set("X-Demo-DB-Delay", "5000")
	if n, err := delayHeader(r, "X-Demo-DB-Delay"); err != nil || n != 5000 {
		t.Fatal(n, err)
	}
}
func TestCanceledWait(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if wait(ctx, 5000) != context.Canceled || time.Since(start) > time.Second {
		t.Fatal("wait did not cancel")
	}
}
func TestReadJSONRejectsMultipleDocuments(t *testing.T) {
	r := httptest.NewRequest("POST", "/", strings.NewReader(`{} {}`))
	if readJSON(r, &map[string]any{}) == nil {
		t.Fatal("accepted multiple documents")
	}
}
func TestNarrowSchemaKeepsFiltersAndIdentity(t *testing.T) {
	s, err := qt.LoadSchema(schemaJSON)
	if err != nil {
		t.Fatal(err)
	}
	narrowed := narrowSchema(s, []string{"total_ms"}, []qt.WhereTerm{{Field: "platform", Op: "=", Value: "linux"}})
	for _, name := range []string{"id", "total_ms", "platform"} {
		if _, ok := narrowed.Fields[name]; !ok {
			t.Fatal("missing", name)
		}
	}
	if _, ok := narrowed.Fields["worker"]; ok {
		t.Fatal("unneeded binding retained")
	}
	if len(s.Fields) <= len(narrowed.Fields) {
		t.Fatal("mutated original schema")
	}
}

// Opt-in read-only tests use an already seeded demo database. No seed/save or
// data mutation occurs, so these are safe to run while exploring the dashboard.
func TestPostgresSnapshotLifetimeAndFractionalFilters(t *testing.T) {
	dsn := os.Getenv("QT_DEMO_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set QT_DEMO_TEST_DATABASE_URL to a seeded demo database")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.RuntimeParams["search_path"] = "qt_demo,public"
	db := stdlib.OpenDB(*config)
	defer db.Close()
	s, err := qt.LoadSchema(schemaJSON)
	if err != nil {
		t.Fatal(err)
	}
	server := &demoServer{db: db, schema: s, secret: make([]byte, 32), slots: make(chan struct{}, 4)}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	if err := server.newSnapshot(ctx); err != nil {
		cancel()
		t.Fatal(err)
	}
	cancel() // exporter must survive cancellation of startup/save request.
	defer server.keeper.Rollback()
	tx, err := db.BeginTx(context.Background(), &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec("SET TRANSACTION SNAPSHOT '" + server.snapshot + "'"); err != nil {
		t.Fatal(err)
	}
	count, err := server.count(context.Background(), tx, []qt.WhereTerm{{Field: "id", Op: "<", Value: "1.5"}}, &timing{})
	if err != nil || count != 1 {
		t.Fatal("fractional filter", count, err)
	}
	// A failed refresh is repaired before exposing cached columns/revisions.
	tx.Rollback()
	old := server.snapshot
	server.snapshotError = context.Canceled
	if err := server.ensureSnapshot(); err != nil {
		t.Fatal(err)
	}
	if server.snapshot == old || server.snapshotError != nil {
		t.Fatal("snapshot not repaired")
	}
	// An HTTP client disconnect during artificial DB latency must reach pg_sleep.
	host := httptest.NewServer(server.withTransaction(func(context.Context, *sql.Tx, *http.Request, *timing) (any, error) { return map[string]any{}, nil }))
	defer host.Close()
	requestContext, stopRequest := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer stopRequest()
	request, err := http.NewRequestWithContext(requestContext, "POST", host.URL, strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-Demo-DB-Delay", "5000")
	if response, err := host.Client().Do(request); err == nil {
		response.Body.Close()
		t.Fatal("request unexpectedly completed")
	}
	deadline := time.Now().Add(2 * time.Second)
	for server.canceled.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if server.canceled.Load() == 0 {
		t.Fatal("client disconnect did not cancel injected PostgreSQL wait promptly")
	}
	server.keeper.Rollback()
}

func TestServerDeadlineRespondsInsteadOfEmptySuccess(t *testing.T) {
	server := &demoServer{}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	w := httptest.NewRecorder()
	server.requestCanceled(w, httptest.NewRequest("POST", "/", nil), ctx)
	if w.Code != http.StatusGatewayTimeout || !strings.Contains(w.Body.String(), "deadline exceeded") || server.canceled.Load() != 0 {
		t.Fatal(w.Code, w.Body.String())
	}
	clientCtx, disconnect := context.WithCancel(context.Background())
	disconnect()
	w = httptest.NewRecorder()
	server.requestCanceled(w, httptest.NewRequest("POST", "/", nil).WithContext(clientCtx), ctx)
	if w.Body.Len() != 0 || server.canceled.Load() != 1 {
		t.Fatal("client disconnect misclassified")
	}
}

func TestPostgresResponseDelayReleasesExecutionResources(t *testing.T) {
	dsn := os.Getenv("QT_DEMO_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set QT_DEMO_TEST_DATABASE_URL")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.RuntimeParams["search_path"] = "qt_demo,public"
	db := stdlib.OpenDB(*config)
	defer db.Close()
	server := &demoServer{db: db, secret: make([]byte, 32), slots: make(chan struct{}, 1)}
	if err = server.newSnapshot(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer server.keeper.Rollback()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request := httptest.NewRequest("POST", "/", strings.NewReader(`{}`)).WithContext(ctx)
	request.Header.Set("X-Demo-Response-Delay", "1000")
	started, finished := make(chan struct{}), make(chan struct{})
	response := httptest.NewRecorder()
	handler := server.withTransaction(func(context.Context, *sql.Tx, *http.Request, *timing) (any, error) {
		close(started)
		return map[string]any{"ok": true}, nil
	})
	go func() { defer close(finished); handler.ServeHTTP(response, request) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not start")
	}
	deadline := time.Now().Add(500 * time.Millisecond)
	for len(server.slots) > 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if len(server.slots) != 0 {
		t.Fatal("response delay occupies execution slot")
	}
	if !server.mu.TryLock() {
		t.Fatal("response delay retains snapshot read lock")
	}
	server.mu.Unlock()
	select {
	case <-finished:
		t.Fatal("response delay was skipped")
	default:
	}
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("response did not finish")
	}
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"ok":true`) {
		t.Fatal(response.Code, response.Body.String())
	}
}

func TestPostgresCommittedSaveSurvivesSnapshotFailure(t *testing.T) {
	dsn := os.Getenv("QT_DEMO_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set QT_DEMO_TEST_DATABASE_URL")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	db := stdlib.OpenDB(*config)
	defer db.Close()
	db.SetMaxOpenConns(1)
	// A connection-local catalogue shadows the real table. No shared demo
	// definitions are written or removed by this regression.
	if _, err = db.Exec(strings.Replace(qt.ComputedColumnsDDL, "CREATE TABLE IF NOT EXISTS", "CREATE TEMP TABLE", 1)); err != nil {
		t.Fatal(err)
	}
	closedDB := stdlib.OpenDB(*config)
	closedDB.Close()
	server := &demoServer{db: closedDB, store: qt.SQLComputedColumnStore{DB: db}}
	store := refreshingStore{server: server}
	request := qt.SaveComputedColumnRequest{Column: qt.ComputedColumn{ID: "review", Label: "Review", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "1"}}}
	saved, err := store.Save(context.Background(), scope, dataset, request)
	if err != nil || saved.Revision != "1" || server.snapshotError == nil {
		t.Fatal(saved, err, server.snapshotError)
	}
	request.Column = saved
	request.Column.Label = "Updated"
	request.ExpectedRevision = &saved.Revision
	updated, err := store.Save(context.Background(), scope, dataset, request)
	if err != nil || updated.Revision != "2" {
		t.Fatal(updated, err)
	}
	columns, err := server.store.List(context.Background(), scope, dataset)
	if err != nil || len(columns) != 1 || columns[0].Label != "Updated" {
		t.Fatal(columns, err)
	}
	if _, err = store.List(context.Background(), scope, dataset); err == nil {
		t.Fatal("stale snapshot execution should stay blocked")
	}
}
