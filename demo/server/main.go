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
	"fmt"
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
type metricTiming struct {
	ID       string `json:"id"`
	SQLMS    int64  `json:"sqlMs"`
	PlanMS   int64  `json:"planMs"`
	Stages   int    `json:"stages"`
	SQLBytes int    `json:"sqlBytes"`
}
type timing struct {
	Metrics                           []metricTiming
	DBDelayMS, SQLMS, ResponseDelayMS int64
	Statements                        int
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
	mux.Handle("POST /api/postgres/rows", s.withTransaction(s.rows))
	mux.Handle("POST /api/postgres/metrics", s.withTransaction(s.metrics))
	mux.Handle("POST /api/postgres/distinct", s.withTransaction(s.distinct))
	mux.Handle("/api/postgres/computed", s.computedHandler())
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
	revisions := map[string]string{}
	caps := map[string]any{}
	for _, id := range ids {
		c, e := resolver.ResolveComputed(ctx, id)
		if e != nil {
			tx.Rollback()
			return e
		}
		columns = append(columns, c)
		revisions[id] = c.Revision
	}
	groupable := map[string]bool{}
	for _, id := range ids {
		groupable[id] = true
	}
	for _, c := range columns {
		plan, e := qt.CompileComputedRows(ctx, qt.WireQuery{Select: []string{"@computed/" + c.ID}, Limit: 1}, s.schema, qt.PlanOptions{SourceSQL: sourceSQL, Resolver: resolver, ExpectedRevisions: revisions, ComputedGroupable: groupable})
		cap := map[string]any{"type": "number", "select": false, "sort": false, "measure": false, "group": false}
		if e == nil {
			typ := plan.Columns[0].Type
			if typ == "null" {
				typ = "text"
			}
			cap = map[string]any{"type": typ, "select": true, "sort": true, "measure": true, "group": true}
		} else {
			cap["reason"] = e.Error()
		}
		caps["@computed/"+c.ID] = cap
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
func (s *demoServer) options(tx *sql.Tx) qt.PlanOptions {
	groups := map[string]bool{}
	for _, c := range s.columns {
		groups[c.ID] = true
	}
	return qt.PlanOptions{SourceSQL: sourceSQL, Resolver: qt.SQLComputedDefinitionResolver{Tx: tx, Scope: scope, Dataset: dataset}, Now: s.reference, Identity: dataset + ":" + s.snapshot, ComputedGroupable: groups,
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
		"completed": s.completed.Load(), "canceled": s.canceled.Load(), "maxRows": 1000, "maxGroups": 10000, "profile": qt.ServerExpressionProfile})
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
		w.Header().Set("X-Demo-Statements", strconv.Itoa(t.Statements))
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
		log.Printf("%s: SQL %dms, DB delay %dms, response delay %dms, %d statements", r.URL.Path, t.SQLMS, t.DBDelayMS, t.ResponseDelayMS, t.Statements)
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

func queryMaps(ctx context.Context, tx *sql.Tx, query string, args []any, t *timing) ([]map[string]any, error) {
	t.Statements++
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for rows.Next() {
		values := make([]any, len(names))
		ptrs := make([]any, len(names))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err = rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		item := map[string]any{}
		for i, name := range names {
			v := jsonValue(values[i])
			if timestamp, ok := v.(time.Time); ok {
				v = timestamp.UTC().Format(time.RFC3339Nano)
			}
			item[name] = v
		}
		out = append(out, item)
		if len(out) > 10000 {
			return nil, errors.New("more than 10000 returned groups; narrow the query")
		}
	}
	return out, rows.Err()
}
func number(value any) int64 {
	switch v := value.(type) {
	case int64:
		return v
	case int32:
		return int64(v)
	case float64:
		return int64(v)
	case string:
		n, _ := strconv.ParseInt(v, 10, 64)
		return n
	}
	return 0
}
func (s *demoServer) count(ctx context.Context, tx *sql.Tx, where []qt.WhereTerm, t *timing) (int64, error) {
	compiled, _, err := qt.CompileAt(qt.WireQuery{Where: where}, s.schema, 1, s.reference)
	if err != nil {
		return 0, err
	}
	query := "SELECT COUNT(*) AS count FROM qt_demo.runs r"
	if compiled.WhereSQL != "" {
		query += " WHERE " + compiled.WhereSQL
	}
	items, err := queryMaps(ctx, tx, query, compiled.Args, t)
	if err != nil {
		return 0, err
	}
	return number(items[0]["count"]), nil
}
func (s *demoServer) rows(ctx context.Context, tx *sql.Tx, r *http.Request, t *timing) (any, error) {
	var q qt.ServerQueryV2
	if e := readJSON(r, &q); e != nil {
		return nil, e
	}
	if q.Limit < 1 || q.Limit > 1000 {
		return nil, errors.New("row page limit must be 1..1000")
	}
	if !contains(q.Select, "id") {
		q.Select = append(q.Select, "id")
	}
	plan, err := qt.CompileRowsV2(ctx, q, s.schema, s.options(tx))
	if err != nil {
		return nil, err
	}
	// Compile again with only reached bindings. MATERIALIZED safe-expression
	// stages should not repeatedly carry unrelated wide source columns.
	plan, err = qt.CompileRowsV2(ctx, q, narrowSchema(s.schema, plan.Dependencies, q.Where), s.options(tx))
	if err != nil {
		return nil, err
	}
	total, err := s.count(ctx, tx, q.Where, t)
	if err != nil {
		return nil, err
	}
	data, err := queryMaps(ctx, tx, plan.SQL, plan.Args, t)
	if err != nil {
		return nil, err
	}
	rows := []map[string]any{}
	computed := []map[string]any{}
	for _, raw := range data {
		row := map[string]any{}
		side := map[string]any{}
		for _, c := range plan.Columns {
			value := raw[c.ValueAlias]
			e := raw[c.ErrorAlias]
			if strings.HasPrefix(c.Field, "@computed/") {
				v := map[string]any{"value": value}
				if e != nil {
					v["error"] = map[string]any{"code": e}
				}
				side[strings.TrimPrefix(c.Field, "@computed/")] = v
			} else {
				if e != nil {
					return nil, fmt.Errorf("field %s: %v", c.Field, e)
				}
				row[c.Field] = value
			}
		}
		rows = append(rows, row)
		computed = append(computed, map[string]any{"id": row["id"], "values": side})
	}
	return map[string]any{"version": 2, "rows": rows, "total": total, "computed": computed, "execution": s.execution()}, nil
}
func contains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}

func (s *demoServer) metrics(ctx context.Context, tx *sql.Tx, r *http.Request, t *timing) (any, error) {
	var q qt.MetricQuery
	if err := readJSON(r, &q); err != nil {
		return nil, err
	}
	if q.Limit < 1 || q.Limit > 1000 {
		return nil, errors.New("row page limit must be 1..1000")
	}
	// Validate the entire request before splitting its plans into card-local errors.
	envelope := q
	envelope.Metrics = nil
	if _, err := qt.CompileMetrics(ctx, envelope, s.schema, s.options(tx)); err != nil {
		return nil, err
	}
	if len(q.Metrics) > 20 {
		return nil, errors.New("at most 20 metrics")
	}
	ids := map[string]bool{}
	for _, spec := range q.Metrics {
		if spec.ID == "" || ids[spec.ID] {
			return nil, errors.New("metric IDs must be nonempty and unique")
		}
		ids[spec.ID] = true
	}
	total, err := s.count(ctx, tx, q.Where, t)
	if err != nil {
		return nil, err
	}
	entries := []map[string]any{}
	for _, spec := range q.Metrics {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		scopeName := spec.Scope
		if scopeName == "" {
			scopeName = "allMatching"
		}
		processed := total
		if scopeName == "shownRows" {
			processed = max(0, min(int64(q.Limit), total-int64(q.Offset)))
		}
		entry := map[string]any{"id": spec.ID, "scope": scopeName, "processedRows": processed, "coverage": "exact", "buckets": []any{}}
		one := q
		one.Metrics = []qt.AggSpec{spec}
		if spec.GroupLimit == 0 {
			one.Metrics[0].GroupLimit = 10000
		}
		if spec.Distribution != nil && spec.Distribution.Kind == "box" && processed > 1000000 {
			entry["error"] = "Exact box plots are limited to 1,000,000 input rows in this demo; narrow the scope."
			entries = append(entries, entry)
			continue
		}
		planStart := time.Now()
		plan, e := qt.CompileMetrics(ctx, one, s.schema, s.options(tx))
		if e != nil {
			entry["error"] = e.Error()
			entries = append(entries, entry)
			continue
		}
		plan, e = qt.CompileMetrics(ctx, one, narrowSchema(s.schema, plan.Metrics[0].Dependencies, q.Where), s.options(tx))
		if e != nil {
			entry["error"] = e.Error()
			entries = append(entries, entry)
			continue
		}
		if _, e = tx.ExecContext(ctx, "SAVEPOINT metric"); e != nil {
			return nil, e
		}
		planMS := time.Since(planStart).Milliseconds()
		sqlStart := time.Now()
		data, e := queryMaps(ctx, tx, plan.Metrics[0].SQL, plan.Metrics[0].Args, t)
		sqlMS := time.Since(sqlStart).Milliseconds()
		t.Metrics = append(t.Metrics, metricTiming{spec.ID, sqlMS, planMS, len(plan.Metrics[0].Stages), len(plan.Metrics[0].SQL)})
		log.Printf("metric %s: SQL %dms, planner %dms, %d stages, %d SQL bytes", spec.ID, sqlMS, planMS, len(plan.Metrics[0].Stages), len(plan.Metrics[0].SQL))
		if e != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if _, rollbackErr := tx.ExecContext(ctx, "ROLLBACK TO SAVEPOINT metric"); rollbackErr != nil {
				return nil, rollbackErr
			}
			entry["error"] = e.Error()
			entries = append(entries, entry)
			continue
		}
		if _, e = tx.ExecContext(ctx, "RELEASE SAVEPOINT metric"); e != nil {
			return nil, e
		}
		buckets := []map[string]any{}
		groupCount := int64(0)
		for _, raw := range data {
			groupCount = number(raw["group_count"])
			keys := []any{}
			for i := range spec.GroupBy {
				keys = append(keys, raw[fmt.Sprintf("group%d", i)])
			}
			bucket := map[string]any{"keys": keys, "value": raw["value"], "count": raw["count"]}
			for _, pair := range [][2]string{{"error", "error"}, {"y", "y"}, {"y_error", "yError"}, {"null_count", "nullCount"}, {"distribution", "distribution"}} {
				if v, ok := raw[pair[0]]; ok && v != nil {
					bucket[pair[1]] = v
				}
			}
			buckets = append(buckets, bucket)
		}
		if groupCount > 10000 {
			entry["error"] = "More than 10,000 groups; narrow the scope or choose coarser grouping."
		} else {
			entry["buckets"] = buckets
			entry["groupCount"] = groupCount
		}
		entries = append(entries, entry)
	}
	return map[string]any{"metrics": entries, "debug": map[string]any{"metrics": t.Metrics}}, nil
}
func (s *demoServer) distinct(ctx context.Context, tx *sql.Tx, r *http.Request, t *timing) (any, error) {
	var q struct {
		Field, Search string
		Limit         int
	}
	if e := readJSON(r, &q); e != nil {
		return nil, e
	}
	limit := q.Limit
	if limit < 1 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}
	compiled, _, err := qt.CompileDistinct(q.Field, q.Search, s.schema, 1)
	if err != nil {
		return nil, err
	}
	query := "SELECT DISTINCT " + compiled.Expr + " AS value FROM qt_demo.runs r"
	if compiled.SearchSQL != "" {
		query += " WHERE " + compiled.SearchSQL
	}
	query += " ORDER BY value NULLS LAST LIMIT " + strconv.Itoa(limit+1)
	items, err := queryMaps(ctx, tx, query, compiled.Args, t)
	if err != nil {
		return nil, err
	}
	values := []string{}
	for _, item := range items {
		if v := item["value"]; v != nil {
			values = append(values, fmt.Sprint(v))
		}
	}
	hasMore := len(values) > limit
	if hasMore {
		values = values[:limit]
	}
	return map[string]any{"values": values, "hasMore": hasMore}, nil
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

// Keep filter bindings (filter planning does not list them as expression
// dependencies), plus the ID as a minimal source for COUNT(). The complete
// allowlist is validated in the first compilation; source SQL stays trusted.
func narrowSchema(schema qt.Schema, dependencies []string, where []qt.WhereTerm) qt.Schema {
	names := map[string]bool{schema.IDField: true}
	for _, name := range dependencies {
		names[name] = true
	}
	for _, term := range where {
		for _, predicate := range term.Predicates() {
			names[predicate.Field] = true
		}
	}
	fields := map[string]qt.FieldSpec{}
	for name, field := range schema.Fields {
		if names[name] {
			fields[name] = field
		}
	}
	schema.Fields = fields
	return schema
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
