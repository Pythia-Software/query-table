// Local-only host adapter for exercising the production Go planners against
// PostgreSQL. The pgx driver belongs to this demo module, not the libraries.
package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

type demoServer struct {
	db                  *sql.DB
	schema              qt.Schema
	store               qt.SQLComputedColumnStore
	mu                  sync.RWMutex
	keeper              *sql.Tx
	snapshot, token     string
	reference           time.Time
	columns             []qt.ComputedColumn
	capabilities        map[string]any
	revisions           map[string]string
	secret              []byte
	rowCount            int
	bytes               int64
	version             string
	slots               chan struct{}
	completed, canceled atomic.Int64
	snapshotError       error
}
type timing struct {
	DBDelayMS, SQLMS, ResponseDelayMS int64
}
type handler func(context.Context, *sql.Tx, *http.Request, *timing) (any, error)

var snapshotPattern = regexp.MustCompile(`^[0-9A-Fa-f-]+$`)

func main() {
	rows := flag.Int("rows", 500000, "deterministic records (1000..2000000)")
	addr := flag.String("addr", "127.0.0.1:5180", "loopback HTTP listener")
	flag.Parse()
	if *rows < 1000 || *rows > 2000000 {
		log.Fatal("rows must be 1000..2000000")
	}
	if !strings.HasPrefix(*addr, "127.0.0.1:") {
		log.Fatal("demo must listen on IPv4 loopback")
	}
	dsn := os.Getenv("QT_DEMO_DATABASE_URL")
	if dsn == "" {
		log.Fatal("QT_DEMO_DATABASE_URL is required; use npm run demo:postgres")
	}
	config, err := pgx.ParseConfig(dsn)
	must(err)
	config.RuntimeParams["search_path"] = "qt_demo,public"
	config.RuntimeParams["timezone"] = "UTC"
	config.RuntimeParams["extra_float_digits"] = "3"
	db := stdlib.OpenDB(*config)
	defer db.Close()
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(8)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	must(db.PingContext(ctx))
	log.Printf("Preparing %s deterministic rows in qt_demo (first launch only unless row count changes)", strconv.Itoa(*rows))
	must(seed(ctx, db, *rows))
	schema, err := qt.LoadSchema(schemaJSON)
	must(err)
	s := &demoServer{db: db, schema: schema, store: qt.SQLComputedColumnStore{DB: db}, rowCount: *rows, slots: make(chan struct{}, 4), secret: make([]byte, 32)}
	_, err = rand.Read(s.secret)
	must(err)
	must(db.QueryRowContext(ctx, `SELECT pg_total_relation_size('qt_demo.runs'),current_setting('server_version')`).Scan(&s.bytes, &s.version))
	must(s.newSnapshot(ctx))
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/postgres/bootstrap", s.bootstrap)
	mux.Handle("POST /api/postgres/query", s.withTransaction(s.query))
	mux.Handle("/api/postgres/computed", s.computedHandler())
	mux.Handle("/api/postgres/query-snapshots", qt.NewQuerySnapshotsHandler(qt.SQLQuerySnapshotStore{DB: db}, func(r *http.Request, name string, write bool) (string, error) {
		if name != dataset {
			return "", errors.New("unknown demo dataset")
		}
		return scope, nil
	}))
	server := &http.Server{Addr: *addr, Handler: s.localOnly(mux), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-shutdown
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(c)
	}()
	log.Printf("Go/PostgreSQL demo ready: http://%s/api/postgres/bootstrap (%d rows, %.1f MB)", *addr, *rows, float64(s.bytes)/1024/1024)
	err = server.ListenAndServe()
	if err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
	s.mu.Lock()
	if s.keeper != nil {
		_ = s.keeper.Rollback()
	}
	s.mu.Unlock()
}
func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

// The exporting transaction remains open. Every row/metric request imports
// this real MVCC snapshot before running any data statement, even across HTTP.
func (s *demoServer) newSnapshot(ctx context.Context) error {
	tx, err := s.db.BeginTx(context.Background(), &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return err
	}
	var snap string
	if err = tx.QueryRowContext(ctx, `SELECT pg_export_snapshot()`).Scan(&snap); err != nil {
		tx.Rollback()
		return err
	}
	if !snapshotPattern.MatchString(snap) {
		tx.Rollback()
		return errors.New("unexpected exported snapshot")
	}
	resolver := qt.SQLComputedDefinitionResolver{Tx: tx, Scope: scope, Dataset: dataset}
	rows, err := tx.QueryContext(ctx, `SELECT id FROM query_table_computed_columns WHERE scope=$1 AND dataset=$2 ORDER BY id`, scope, dataset)
	if err != nil {
		tx.Rollback()
		return err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		ids = append(ids, id)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		tx.Rollback()
		return err
	}
	columns := []qt.ComputedColumn{}
	for _, id := range ids {
		c, e := resolver.ResolveComputed(ctx, id)
		if e != nil {
			tx.Rollback()
			return e
		}
		columns = append(columns, c)
	}
	description, err := s.dataset(columns).DescribeComputedPartialIn(ctx, tx, ids, qt.PlanOptions{Resolver: resolver})
	if err != nil {
		tx.Rollback()
		return err
	}
	revisions := description.Execution.ResolvedRevisions
	caps := map[string]any{}
	for name, capability := range description.Execution.Fields {
		caps[name] = capability
	}
	for id, issue := range description.Diagnostics {
		caps["@computed/"+id] = map[string]any{"type": "number", "select": false, "sort": false, "measure": false, "group": false, "reason": issue.Error()}
	}
	hash := hmac.New(sha256.New, s.secret)
	data, _ := json.Marshal(revisions)
	hash.Write([]byte(snap))
	hash.Write(data)
	old := s.keeper
	s.keeper = tx
	s.snapshot = snap
	s.token = hex.EncodeToString(hash.Sum(nil))
	s.reference = time.Now().UTC()
	s.columns = columns
	s.revisions = revisions
	s.capabilities = caps
	if old != nil {
		_ = old.Rollback()
	}
	return nil
}
func (s *demoServer) execution() map[string]any {
	return map[string]any{"profile": qt.ServerExpressionProfile, "planToken": s.token, "snapshot": s.snapshot, "resolvedRevisions": s.revisions, "fields": s.capabilities}
}

// One demo dataset: the library executes every v3 request against the source,
// including the computed definitions of the current snapshot.
func (s *demoServer) dataset(columns []qt.ComputedColumn) qt.QueryDatasetV3 {
	groups := map[string]bool{}
	for _, c := range columns {
		groups[c.ID] = true
	}
	return qt.QueryDatasetV3{Schema: s.schema, SourceSQL: sourceSQL, Scope: scope, Dataset: dataset, Dialect: "postgres",
		ComputedGroupable: groups, MaxRows: 1000, MaxGroups: 10000, MaxPopulation: 2000000, MaxSamplesPerGroup: 1000000}
}
func (s *demoServer) options(tx *sql.Tx) qt.PlanOptions {
	return qt.PlanOptions{Resolver: qt.SQLComputedDefinitionResolver{Tx: tx, Scope: scope, Dataset: dataset}, Now: s.reference, Identity: dataset + ":" + s.snapshot,
		ValidateSnapshot: func(ctx context.Context, token string) error {
			if token != s.snapshot {
				return errors.New("snapshot expired; reload the demo connection")
			}
			return nil
		},
		ValidatePlanToken: func(ctx context.Context, token string) error {
			if !hmac.Equal([]byte(token), []byte(s.token)) {
				return errors.New("execution changed; reload the demo connection")
			}
			return nil
		}}
}
func (s *demoServer) localOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		origin := r.Header.Get("Origin")
		if origin != "" && origin != "http://localhost:5179" && origin != "http://127.0.0.1:5179" && origin != "http://localhost:5180" && origin != "http://127.0.0.1:5180" {
			writeError(w, errors.New("local demo origin required"), http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
func (s *demoServer) bootstrap(w http.ResponseWriter, r *http.Request) {
	if err := s.ensureSnapshot(); err != nil {
		writeError(w, err, 503)
		return
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	_ = json.NewEncoder(w).Encode(map[string]any{
		"dataset": dataset, "rows": s.rowCount, "bytes": s.bytes, "postgresVersion": s.version, "execution": s.execution(), "columns": s.columns,
		"completed": s.completed.Load(), "canceled": s.canceled.Load(), "capabilities": s.dataset(s.columns).Capabilities()})
}
func delayHeader(r *http.Request, name string) (int64, error) {
	v := r.Header.Get(name)
	if v == "" {
		return 0, nil
	}
	n, e := strconv.ParseInt(v, 10, 64)
	if e != nil || n < 0 || n > 5000 {
		return 0, errors.New("demo delay must be 0..5000 ms")
	}
	return n, nil
}
func wait(ctx context.Context, delay int64) error {
	if delay == 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(time.Duration(delay) * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func writeError(w http.ResponseWriter, err error, status int) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}
func readJSON(r *http.Request, out any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if e := decoder.Decode(out); e != nil {
		return e
	}
	if e := decoder.Decode(new(any)); e != io.EOF {
		return errors.New("expected exactly one JSON request")
	}
	return nil
}

func (s *demoServer) withTransaction(run handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
		defer cancel()
		t := &timing{}
		var err error
		t.DBDelayMS, err = delayHeader(r, "X-Demo-DB-Delay")
		if err != nil {
			writeError(w, err, 400)
			return
		}
		t.ResponseDelayMS, err = delayHeader(r, "X-Demo-Response-Delay")
		if err != nil {
			writeError(w, err, 400)
			return
		}
		// Drain the bounded request body before waiting for a slot or injecting
		// database latency. net/http can then detect a disconnected client while
		// pg_sleep is running, rather than only when the body is read afterward.
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		_ = r.Body.Close()
		if err != nil {
			writeError(w, err, http.StatusBadRequest)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		start := time.Now()
		select {
		case s.slots <- struct{}{}:
		case <-ctx.Done():
			s.requestCanceled(w, r, ctx)
			return
		}
		s.mu.RLock()
		released := false
		release := func() {
			if !released {
				s.mu.RUnlock()
				<-s.slots
				released = true
			}
		}
		defer release()
		if s.snapshotError != nil {
			writeError(w, errors.New("snapshot refresh failed; reconnect to retry"), 503)
			return
		}
		tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
		if err != nil {
			writeError(w, err, 503)
			return
		}
		defer tx.Rollback()
		// Snapshot comes only from pg_export_snapshot(), validated at capture, never request SQL.
		if _, err = tx.ExecContext(ctx, "SET TRANSACTION SNAPSHOT '"+s.snapshot+"'"); err != nil {
			writeError(w, err, 503)
			return
		}
		if _, err = tx.ExecContext(ctx, `SET LOCAL statement_timeout='60s'; SET LOCAL work_mem='32MB'; SET LOCAL temp_file_limit='2GB'`); err != nil {
			writeError(w, err, 503)
			return
		}
		if t.DBDelayMS > 0 {
			_, err = tx.ExecContext(ctx, `SELECT pg_sleep($1::double precision / 1000)`, t.DBDelayMS)
		}
		var result any
		if err == nil {
			sqlStart := time.Now()
			result, err = run(ctx, tx, r, t)
			t.SQLMS = time.Since(sqlStart).Milliseconds()
		}
		if err == nil {
			err = tx.Commit()
		}
		_ = tx.Rollback() // Also close failed transactions before freeing execution capacity.
		release()
		if ctx.Err() != nil || r.Context().Err() != nil {
			s.requestCanceled(w, r, ctx)
			log.Printf("cancelled %s (%dms)", r.URL.Path, time.Since(start).Milliseconds())
			return
		}
		// Connection remains cancellable during simulated Go→browser delay. The
		// transaction is already closed, so this stage doesn't occupy a DB connection.
		if e := wait(ctx, t.ResponseDelayMS); e != nil {
			s.requestCanceled(w, r, ctx)
			return
		}
		w.Header().Set("X-Demo-SQL-Ms", strconv.FormatInt(t.SQLMS, 10))
		w.Header().Set("X-Demo-DB-Delay-Ms", strconv.FormatInt(t.DBDelayMS, 10))
		w.Header().Set("X-Demo-Response-Delay-Ms", strconv.FormatInt(t.ResponseDelayMS, 10))
		w.Header().Set("X-Demo-Server-Ms", strconv.FormatInt(time.Since(start).Milliseconds(), 10))
		if err != nil {
			log.Printf("%s: %v", r.URL.Path, err)
			writeError(w, err, 422)
			return
		}
		payload, e := json.Marshal(result)
		if e != nil {
			writeError(w, e, 500)
			return
		}
		if len(payload) > 8<<20 {
			writeError(w, errors.New("demo response exceeds 8 MB budget"), 422)
			return
		}
		s.completed.Add(1)
		_, _ = w.Write(payload)
		log.Printf("%s: SQL %dms, DB delay %dms, response delay %dms", r.URL.Path, t.SQLMS, t.DBDelayMS, t.ResponseDelayMS)
	})
}

// A server deadline is an HTTP failure while the client is still connected.
// Disconnected clients require no response and are counted as cancellations.
func (s *demoServer) requestCanceled(w http.ResponseWriter, r *http.Request, ctx context.Context) {
	if r.Context().Err() != nil {
		s.canceled.Add(1)
		return
	}
	writeError(w, ctx.Err(), http.StatusGatewayTimeout)
}

func (s *demoServer) query(ctx context.Context, tx *sql.Tx, r *http.Request, _ *timing) (any, error) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	q, err := qt.DecodeQueryRequestV3(body)
	if err != nil {
		return nil, err
	}
	return s.dataset(s.columns).ExecuteIn(ctx, tx, q, s.options(tx))
}
func (s *demoServer) computedHandler() http.Handler {
	store := refreshingStore{server: s}
	return qt.NewComputedColumnsHandler(store, func(r *http.Request, name string, write bool) (string, error) {
		if name != dataset {
			return "", errors.New("unknown demo dataset")
		}
		return scope, nil
	})
}

type refreshingStore struct{ server *demoServer }

func (store refreshingStore) List(ctx context.Context, scopeName, datasetName string) ([]qt.ComputedColumn, error) {
	s := store.server
	if err := s.ensureSnapshot(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]qt.ComputedColumn{}, s.columns...), nil
}
func (store refreshingStore) Save(ctx context.Context, scopeName, datasetName string, q qt.SaveComputedColumnRequest) (qt.ComputedColumn, error) {
	s := store.server
	s.mu.Lock()
	defer s.mu.Unlock()
	c, err := s.store.Save(ctx, scopeName, datasetName, q)
	if err != nil {
		return c, err
	}
	// The write has committed. HTTP cancellation must not abandon the new
	// canonical catalogue/exporter. If refresh fails, block stale execution and
	// let bootstrap/list repair it instead of advertising obsolete revisions.
	refreshContext, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	err = s.newSnapshot(refreshContext)
	s.snapshotError = err
	if err != nil {
		log.Printf("definition %s saved; snapshot refresh failed: %v", c.ID, err)
	}
	return c, nil
}

func (s *demoServer) ensureSnapshot() error {
	s.mu.RLock()
	needsRepair := s.snapshotError != nil
	s.mu.RUnlock()
	if !needsRepair {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.snapshotError == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	s.snapshotError = s.newSnapshot(ctx)
	return s.snapshotError
}
