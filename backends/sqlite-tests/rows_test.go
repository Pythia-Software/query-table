package sqlitetests

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func rowsSchema() qt.Schema {
	s := qt.Schema{Name: "memory", IDField: "id", Fields: map[string]qt.FieldSpec{}}
	for name, kind := range map[string]qt.FieldKind{"id": qt.FieldText, "text": qt.FieldText, "enum": qt.FieldEnum, "n": qt.FieldNumber, "n2": qt.FieldNumber, "n3": qt.FieldNumber, "n4": qt.FieldNumber, "n5": qt.FieldNumber, "flag": qt.FieldBool, "tags": qt.FieldTextArray, "stamp": qt.FieldDatetime, "millis": qt.FieldDatetime, "unix": qt.FieldDatetime, "seconds": qt.FieldDatetime} {
		s.Fields[name] = qt.FieldSpec{Name: name, Kind: kind, Expr: "r." + name, Sortable: true, ServerFilter: true, ExpressionNumeric: true}
	}
	for name, format := range map[string]string{"stamp": "rfc3339", "millis": "utc-millis", "unix": "unix-millis", "seconds": "unix-seconds"} {
		f := s.Fields[name]
		f.SQLiteDatetimeFormat = format
		s.Fields[name] = f
	}
	return s
}
func openRowsDB(tb testing.TB) *sql.DB {
	tb.Helper()
	db, e := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(tb.TempDir(), "rows.db")))
	if e != nil {
		tb.Fatal(e)
	}
	tb.Cleanup(func() { db.Close() })
	return db
}
func stageMemoryRows(tb testing.TB, tx *sql.Tx, s qt.Schema, rows []map[string]any) {
	tb.Helper()
	columns := []string{"id", "text", "enum", "n", "n2", "n3", "n4", "n5", "flag", "tags", "stamp", "millis", "unix", "seconds"}
	quoted := make([]string, len(columns))
	marks := make([]string, len(columns))
	for i, c := range columns {
		quoted[i] = `"` + c + `"`
		marks[i] = "?"
	}
	if _, e := tx.Exec("CREATE TEMP TABLE memory (" + strings.Join(quoted, ",") + ")"); e != nil {
		tb.Fatal(e)
	}
	stmt, e := tx.Prepare("INSERT INTO memory VALUES (" + strings.Join(marks, ",") + ")")
	if e != nil {
		tb.Fatal(e)
	}
	defer stmt.Close()
	for _, row := range rows {
		values, e := qt.SQLiteRowValues(row, s, columns)
		if e != nil {
			tb.Fatal(e)
		}
		if _, e = stmt.Exec(values...); e != nil {
			tb.Fatal(e)
		}
	}
}
func rowsFixture() []map[string]any {
	rng := rand.New(rand.NewSource(16))
	rows := []map[string]any{{"id": "empty"}}
	texts := []any{nil, "", "ÉCOLE", "İSTANBUL", "axb", "red", "nil", "x🙂y", "école"}
	tags := []any{nil, "", "[]", `["ÉCOLE","red"]`, `["İSTANBUL"]`, `[null]`, `[1]`, `["🙂"]`, `{}`}
	stamps := []any{nil, "", "2026-01-01", "2026-01-01T00:00:00+02:00", "2026-01-01T00:00:00.000499999Z", "2026-01-01T00:00:00Z"}
	for i := 0; i < 120; i++ {
		row := map[string]any{"id": fmt.Sprintf("r%03d", i), "text": texts[rng.Intn(len(texts))], "enum": texts[rng.Intn(len(texts))], "tags": tags[rng.Intn(len(tags))], "stamp": stamps[rng.Intn(len(stamps))]}
		nums := []any{nil, int64(0), int64(-7), float64(0.1), float64(1.5), int64(11)}
		flags := []any{nil, int64(0), int64(1)}
		row["n"] = nums[rng.Intn(len(nums))]
		row["n2"] = nums[rng.Intn(len(nums))]
		row["flag"] = flags[rng.Intn(len(flags))]
		row["millis"] = "2026-01-01T00:00:00.000Z"
		row["unix"] = float64(1767225600000)
		row["seconds"] = float64(1767225600)
		rows = append(rows, row)
	}
	return rows
}
func compareMemory(tb testing.TB, tx *sql.Tx, d qt.SQLiteV2Dataset, rows []map[string]any, q qt.MetricQuery, o qt.PlanOptions) {
	tb.Helper()
	got, ge := qt.ExecuteV2Rows(context.Background(), tx, d, rows, q, o)
	want, we := d.ExecuteV2In(context.Background(), tx, nil, &q, o)
	if ge != nil || we != nil {
		if fmt.Sprint(ge) != fmt.Sprint(we) {
			tb.Fatalf("errors: memory %v SQL %v", ge, we)
		}
		return
	}
	gb, _ := json.Marshal(got)
	wb, _ := json.Marshal(want)
	if string(gb) != string(wb) {
		tb.Fatalf("query %+v\nmemory %s\nSQL    %s", q, gb, wb)
	}
}
func TestRowsFilterDifferential(t *testing.T) {
	s := rowsSchema()
	rows := rowsFixture()
	db := openRowsDB(t)
	tx, e := db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	stageMemoryRows(t, tx, s, rows)
	now := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	cases := []qt.WhereTerm{}
	for _, field := range []string{"text", "enum", "n", "n2", "n3", "n4", "n5", "flag", "tags", "stamp", "millis", "unix", "seconds"} {
		for _, op := range []string{"is_null", "is_not_null"} {
			cases = append(cases, qt.WhereTerm{Field: field, Op: op})
		}
	}
	for _, field := range []string{"text", "enum"} {
		for _, op := range []string{"=", "!=", "contains", "starts_with", "ends_with", "matches_regex", "not_matches_regex", "length_eq", "length_gt", "length_lt"} {
			values := []string{"", "ÉCOLE", "nil", "🙂", "İ"}
			if strings.Contains(op, "length_") {
				values = []string{"0", "1", "5", "7"}
			}
			if strings.Contains(op, "regex") {
				values = []string{"(?i)^é", "🙂", "^$", "a.b"}
			}
			for _, v := range values {
				cases = append(cases, qt.WhereTerm{Field: field, Op: op, Value: v})
			}
		}
	}
	for _, field := range []string{"n", "flag", "stamp", "millis", "unix", "seconds"} {
		for _, op := range []string{"=", "!=", ">", ">=", "<", "<="} {
			values := []string{"", "0", "-1", "1.5"}
			if field == "flag" {
				values = []string{"", "true", "false"}
			}
			if field == "stamp" || field == "millis" || field == "unix" || field == "seconds" {
				values = []string{"", "2026-01-01", "2026-01-01T00:00:00.000000001Z", "2026-01-01T00:00:00.000999999Z", "-1d", "+1h"}
			}
			for _, v := range values {
				cases = append(cases, qt.WhereTerm{Field: field, Op: op, Value: v})
			}
		}
	}
	for _, v := range []string{"", "école", "İ", "RED", "🙂"} {
		cases = append(cases, qt.WhereTerm{Field: "tags", Op: "includes", Value: v})
	}
	for _, sensitive := range []bool{false, true} {
		f := s.Fields["tags"]
		f.ArrayCaseSensitive = sensitive
		s.Fields["tags"] = f
		for _, c := range cases {
			for _, neg := range []bool{false, true} {
				c.Negated = neg
				// enum supports the text matrix, as validated by the actual compiler.
				filter, e := qt.CompileRowFilter([]qt.WhereTerm{c}, s, qt.SQLiteOptions{Now: now})
				sqlFilter, se := qt.CompileSQLiteWhere([]qt.WhereTerm{c}, s, qt.SQLiteOptions{Now: now})
				if e != nil || se != nil {
					if fmt.Sprint(e) != fmt.Sprint(se) {
						t.Fatalf("%+v: %v / %v", c, e, se)
					}
					continue
				}
				where := ""
				if sqlFilter.SQL != "" {
					where = " WHERE " + sqlFilter.SQL
				}
				found, e := tx.Query("SELECT id FROM memory AS r"+where+" ORDER BY id", sqlFilter.Args...)
				if e != nil {
					t.Fatal(e)
				}
				want := []string{}
				for found.Next() {
					var id string
					if e = found.Scan(&id); e != nil {
						t.Fatal(e)
					}
					want = append(want, id)
				}
				if e = found.Err(); e != nil {
					t.Fatal(e)
				}
				found.Close()
				got := []string{}
				for _, row := range rows {
					matches, e := filter.Match(row)
					if e != nil {
						t.Fatalf("%+v: %v", c, e)
					}
					if matches {
						got = append(got, row["id"].(string))
					}
				}
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("sensitive=%v %+v\ngot %v\nwant %v", sensitive, c, got, want)
				}
			}
		}
	}
}
func TestRowsMetricsDifferential(t *testing.T) {
	s := rowsSchema()
	rows := rowsFixture()
	db := openRowsDB(t)
	tx, e := db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	stageMemoryRows(t, tx, s, rows)
	d := qt.SQLiteV2Dataset{Schema: s, SourceSQL: "SELECT * FROM memory"}
	rng := rand.New(rand.NewSource(160))
	for i := 0; i < 80; i++ {
		q := qt.MetricQuery{Version: 2, Profile: qt.SQLiteExpressionProfile}
		if i%3 == 0 {
			q.Where = []qt.WhereTerm{{Any: []qt.WhereClause{{Field: "n", Op: ">", Value: "0"}, {Field: "text", Op: "contains", Value: "é"}}}}
		}
		for j, op := range []string{"count", "count", "sum", "sum", "avg", "min", "max", "count_distinct", "count_distinct", "count", "count_distinct", "min", "max"} {
			field := []string{"", "n", "n", "n2", "n2", "n", "text", "enum", "flag", "stamp", "stamp", "stamp", "unix"}[j]
			spec := qt.AggSpec{ID: fmt.Sprint(j), Op: op, Field: field}
			if i%4 != 0 {
				spec.GroupBy = [][]string{{"text"}, {"enum", "flag"}, {"enum", "text"}}[rng.Intn(3)]
			}
			if i%5 == 0 {
				spec.Where = []qt.WhereTerm{{Field: "n2", Op: "!=", Value: "0"}}
			}
			if len(spec.GroupBy) > 0 && i%6 == 0 {
				spec.MinCount = 3
			}
			if i%7 == 0 {
				spec.GroupLimit = 2
			}
			if i%2 == 0 {
				spec.Sort = []qt.MetricSort{{Key: "count", Dir: "asc"}, {Key: "value", Dir: "desc", Nulls: "first"}}
			}
			q.Metrics = append(q.Metrics, spec)
		}
		compareMemory(t, tx, d, rows, q, qt.PlanOptions{})
	}
}
func TestRowsErrorsAndBudgets(t *testing.T) {
	for name, values := range map[string][]any{"tenths": {0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1}, "unsafe": {int64(1<<53 + 1), int64(1)}, "overflow": {int64(1 << 52), int64(1 << 52)}, "storage": {float64(2), "garbage"}, "range": {1e101, 1e-301}, "promotion": {1.2345678901234567, 9.876543210987654, -1.2345678901234567, 1e-300}, "scientific": {1.2e-10, -3.4e-5, 1e-100, 1e-300}, "cancellation": {int64(1 << 52), int64(1 << 52), int64(-1 << 52), int64(-1 << 52)}, "nonfinite": {math.Inf(1), math.NaN()}, "empty": {}} {
		t.Run(name, func(t *testing.T) {
			s := rowsSchema()
			rows := []map[string]any{}
			for i, v := range values {
				rows = append(rows, map[string]any{"id": fmt.Sprint(i), "text": fmt.Sprint(i), "n": v})
			}
			db := openRowsDB(t)
			tx, e := db.Begin()
			if e != nil {
				t.Fatal(e)
			}
			defer tx.Rollback()
			stageMemoryRows(t, tx, s, rows)
			d := qt.SQLiteV2Dataset{Schema: s, SourceSQL: "SELECT * FROM memory"}
			q := qt.MetricQuery{Version: 2, Metrics: []qt.AggSpec{{ID: "sum", Op: "sum", Field: "n"}, {ID: "avg", Op: "avg", Field: "n"}, {ID: "min", Op: "min", Field: "n"}, {ID: "max", Op: "max", Field: "n"}, {ID: "count", Op: "count", Field: "n"}, {ID: "distinct", Op: "count_distinct", Field: "n"}, {ID: "groups", Op: "count", GroupBy: []string{"text"}}}}
			compareMemory(t, tx, d, rows, q, qt.PlanOptions{})
			d.MaxPopulation = 1
			compareMemory(t, tx, d, rows, q, qt.PlanOptions{})
			d.MaxPopulation = 0
			d.MaxGroups = 1
			compareMemory(t, tx, d, rows, q, qt.PlanOptions{})
			q.Metrics[6].MinCount = 2
			compareMemory(t, tx, d, rows, q, qt.PlanOptions{})
		})
	}
}
func TestRowsUnsupportedAndNilTransaction(t *testing.T) {
	d := qt.SQLiteV2Dataset{Schema: rowsSchema()}
	q := qt.MetricQuery{Version: 2, Metrics: []qt.AggSpec{{ID: "m", Op: "count"}}}
	if _, e := qt.ExecuteV2Rows(context.Background(), nil, d, []map[string]any{{}}, q, qt.PlanOptions{}); e != nil {
		t.Fatal(e)
	}
	for _, spec := range []qt.AggSpec{{ID: "m", Expression: "SUM([n])+1"}, {ID: "m", Expression: "MEDIAN([n])"}, {ID: "m", Op: "count", Scope: "shownRows"}} {
		q.Metrics = []qt.AggSpec{spec}
		q.Limit = 2
		got, e := qt.ExecuteV2Rows(context.Background(), nil, d, nil, q, qt.PlanOptions{})
		if !errors.Is(e, qt.ErrRowsUnsupported) || got.Metrics != nil {
			t.Fatalf("%+v: %+v %v", spec, got, e)
		}
	}
	q.Metrics = []qt.AggSpec{{ID: "m", Op: "count"}, {ID: "s", Op: "sum", Field: "n"}}
	got, e := qt.ExecuteV2Rows(context.Background(), nil, d, []map[string]any{{"n": int(1)}}, q, qt.PlanOptions{})
	if !errors.Is(e, qt.ErrRowsUnsupported) || got.Metrics != nil {
		t.Fatalf("%+v %v", got, e)
	}
}

func BenchmarkV2RowsTokenSummary(b *testing.B) {
	s := rowsSchema()
	rows := make([]map[string]any, 50000)
	for i := range rows {
		rows[i] = map[string]any{"id": fmt.Sprint(i), "enum": []string{"a", "b", "c"}[i%3], "n": int64(i % 1000), "n2": float64(i%700) / 100, "n3": int64(i % 20), "n4": int64(i % 40), "n5": int64(i % 60), "text": fmt.Sprint(i % 700)}
	}
	q := qt.MetricQuery{Version: 2, Metrics: []qt.AggSpec{{ID: "1", Op: "sum", Field: "n"}, {ID: "2", Op: "sum", Field: "n2"}, {ID: "3", Op: "sum", Field: "n3"}, {ID: "4", Op: "sum", Field: "n4"}, {ID: "5", Op: "sum", Field: "n5"}, {ID: "sessions", Op: "count_distinct", Field: "text"}}}
	db := openRowsDB(b)
	d := qt.SQLiteV2Dataset{Schema: s, SourceSQL: "SELECT * FROM memory"}
	for _, filtered := range []bool{false, true} {
		name := "unfiltered"
		if filtered {
			name = "filtered"
			q.Where = []qt.WhereTerm{{Field: "enum", Op: "!=", Value: "b"}}
		}
		b.Run(name+"/rows", func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				if _, e := qt.ExecuteV2Rows(context.Background(), nil, d, rows, q, qt.PlanOptions{}); e != nil {
					b.Fatal(e)
				}
			}
		})
		b.Run(name+"/staged", func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				tx, e := db.Begin()
				if e != nil {
					b.Fatal(e)
				}
				stageMemoryRows(b, tx, s, rows)
				_, e = d.ExecuteV2In(context.Background(), tx, nil, &q, qt.PlanOptions{})
				tx.Rollback()
				if e != nil {
					b.Fatal(e)
				}
			}
		})
	}
}

func TestRowsValidationAndRevisions(t *testing.T) {
	s := rowsSchema()
	db := openRowsDB(t)
	tx, e := db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	rows := []map[string]any{{"id": "a", "n": int64(1)}, {"id": "b", "n": int64(2)}}
	stageMemoryRows(t, tx, s, rows)
	d := qt.SQLiteV2Dataset{Schema: s, SourceSQL: "SELECT * FROM memory"}
	base := qt.MetricQuery{Version: 2, Metrics: []qt.AggSpec{{ID: "m", Op: "count"}}}
	for _, change := range []func(*qt.MetricQuery){
		func(q *qt.MetricQuery) { q.Version = 1 }, func(q *qt.MetricQuery) { q.Profile = "other" }, func(q *qt.MetricQuery) { q.PlanToken = "invalid" }, func(q *qt.MetricQuery) { q.Snapshot = "invalid" }, func(q *qt.MetricQuery) { q.Diagnostics = []any{"residual"} }, func(q *qt.MetricQuery) { q.Limit = 10001 }, func(q *qt.MetricQuery) {
			q.Metrics = []qt.AggSpec{{ID: "same", Op: "count"}, {ID: "same", Op: "count"}}
		}, func(q *qt.MetricQuery) { q.Where = []qt.WhereTerm{{Field: "missing", Op: "=", Value: "x"}} },
	} {
		q := base
		change(&q)
		compareMemory(t, tx, d, rows, q, qt.PlanOptions{})
	}
	// Invalid clauses retain the adapter's per-metric failure envelopes.
	q := base
	q.Metrics = []qt.AggSpec{{ID: "good", Op: "count"}, {ID: "bad", Op: "sum", Field: "text"}, {ID: "sort", Op: "count", Sort: []qt.MetricSort{{Key: "wrong", Dir: "asc"}}}, {ID: "min", Op: "count", MinCount: 2}, {ID: "regex", Op: "count", Where: []qt.WhereTerm{{Field: "text", Op: "matches_regex", Value: "x"}}}}
	compareMemory(t, tx, d, rows, q, qt.PlanOptions{})
	calls := 0
	resolver := qt.DefinitionResolverFunc(func(_ context.Context, id string) (qt.ComputedColumn, error) {
		calls++
		return qt.ComputedColumn{ID: id, Label: "Test", Revision: "1", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "[n]*2"}}, nil
	})
	o := qt.PlanOptions{Resolver: resolver}
	q = base
	q.ExpectedRevisions = map[string]string{"hidden": "1"}
	compareMemory(t, tx, d, rows, q, o)
	q.ExpectedRevisions = map[string]string{"hidden": "stale"}
	compareMemory(t, tx, d, rows, q, o)
	d.MaxPopulation = 1
	compareMemory(t, tx, d, rows, q, o)
	d.MaxPopulation = 0
	q.ExpectedRevisions = map[string]string{"": "1"}
	compareMemory(t, tx, d, rows, q, o)
	if calls == 0 {
		t.Fatal("unused revisions were not verified")
	}
	q = base
	q.ExpectedRevisions = map[string]string{"hidden": "1"}
	if _, e = qt.ExecuteV2Rows(context.Background(), nil, d, rows, q, o); e != nil {
		t.Fatal("host resolver without transaction:", e)
	}
	if _, e = qt.ExecuteV2Rows(context.Background(), nil, d, rows, q, qt.PlanOptions{}); e == nil {
		t.Fatal("revision request accepted without a resolver transaction")
	}
	q = base
	q.Metrics = []qt.AggSpec{{ID: "computed", Op: "sum", Field: "@computed/hidden"}}
	if _, e = qt.ExecuteV2Rows(context.Background(), nil, d, rows, q, qt.PlanOptions{}); !errors.Is(e, qt.ErrRowsUnsupported) {
		t.Fatal("computed metric did not request fallback:", e)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e = qt.ExecuteV2Rows(canceled, nil, d, rows, base, qt.PlanOptions{}); !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
}
func TestRowsStorageComparison(t *testing.T) {
	s := rowsSchema()
	rows := []map[string]any{{"id": "a", "n": "10", "text": int64(5)}, {"id": "b", "n": int64(9007199254740993), "text": float64(1.5)}, {"id": "c", "n": int64(9007199254740992)}, {"id": "d", "n": math.NaN()}, {"id": "e", "n": math.Inf(-1)}}
	db := openRowsDB(t)
	tx, e := db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	stageMemoryRows(t, tx, s, rows)
	d := qt.SQLiteV2Dataset{Schema: s, SourceSQL: "SELECT * FROM memory"}
	for _, field := range []string{"n", "text"} {
		for _, op := range []string{"=", "!=", ">", "<", ">=", "<="} {
			for _, v := range []string{"9007199254740992", "9007199254740994", "5"} {
				q := qt.MetricQuery{Version: 2, Where: []qt.WhereTerm{{Field: field, Op: op, Value: v}}, Metrics: []qt.AggSpec{{ID: "m", Op: "count"}}}
				compareMemory(t, tx, d, rows, q, qt.PlanOptions{})
			}
		}
	}
}

func TestRowsDatetimeMeasures(t *testing.T) {
	s := rowsSchema()
	rows := []map[string]any{{"id": "a", "stamp": "2026-01-01", "millis": "2026-01-01T00:00:00.000Z", "unix": float64(1767225600000.001)}, {"id": "b", "stamp": "2026-01-01T00:00:00+02:00", "millis": "2026-01-01T00:00:00Z", "unix": int64(1)}, {"id": "c", "stamp": "invalid", "millis": int64(0), "unix": "bad"}, {"id": "d", "stamp": "", "millis": "", "unix": ""}, {"id": "e"}}
	db := openRowsDB(t)
	tx, e := db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	stageMemoryRows(t, tx, s, rows)
	d := qt.SQLiteV2Dataset{Schema: s, SourceSQL: "SELECT * FROM memory"}
	q := qt.MetricQuery{Version: 2}
	for _, field := range []string{"stamp", "millis", "unix"} {
		for _, op := range []string{"count", "count_distinct", "min", "max"} {
			q.Metrics = append(q.Metrics, qt.AggSpec{ID: field + op, Field: field, Op: op})
		}
	}
	compareMemory(t, tx, d, rows, q, qt.PlanOptions{})
}

func TestRowsDecimalDifferential(t *testing.T) {
	s := rowsSchema()
	rng := rand.New(rand.NewSource(1616))
	rows := []map[string]any{}
	for i := range 1500 {
		exponent := []int{0, 1, 2, 3, 7, 10, 18, 100, 299}[i%9]
		n := float64(rng.Intn(100000)-50000) / math.Pow10(exponent)
		rows = append(rows, map[string]any{"id": fmt.Sprint(i), "text": fmt.Sprint(i % 19), "n": n, "n2": float64(rng.Intn(5000)) / 100})
	}
	db := openRowsDB(t)
	tx, e := db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	stageMemoryRows(t, tx, s, rows)
	d := qt.SQLiteV2Dataset{Schema: s, SourceSQL: "SELECT * FROM memory"}
	for _, groups := range [][]string{nil, {"text"}} {
		q := qt.MetricQuery{Version: 2}
		for _, field := range []string{"n", "n2"} {
			for _, op := range []string{"sum", "avg"} {
				q.Metrics = append(q.Metrics, qt.AggSpec{ID: op + field, Op: op, Field: field, GroupBy: groups})
			}
		}
		compareMemory(t, tx, d, rows, q, qt.PlanOptions{})
		// The decimal result is invariant to row visitation order.
		rng.Shuffle(len(rows), func(i, j int) { rows[i], rows[j] = rows[j], rows[i] })
		compareMemory(t, tx, d, rows, q, qt.PlanOptions{})
	}
}

func TestRowsTransactionUsage(t *testing.T) {
	db := openRowsDB(t)
	if _, e := db.Exec(qt.SQLiteComputedColumnsDDL); e != nil {
		t.Fatal(e)
	}
	store := qt.SQLiteComputedColumnStore{DB: db}
	column := qt.ComputedColumn{ID: "hidden", Label: "Hidden", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "[n]*2"}}
	if _, e := store.Save(context.Background(), "scope", "memory", qt.SaveComputedColumnRequest{Column: column}); e != nil {
		t.Fatal(e)
	}
	d := qt.SQLiteV2Dataset{Schema: rowsSchema(), Scope: "scope", Dataset: "memory"}
	q := qt.MetricQuery{Version: 2, ExpectedRevisions: map[string]string{"hidden": "1"}, Metrics: []qt.AggSpec{{ID: "count", Op: "count"}}}
	tx, e := db.Begin()
	if e != nil {
		t.Fatal(e)
	}
	if _, e = qt.ExecuteV2Rows(context.Background(), tx, d, []map[string]any{{}}, q, qt.PlanOptions{}); e != nil {
		t.Fatal(e)
	}
	tx.Rollback()
	// An ordinary request succeeds even with a closed transaction, unreachable
	// source SQL, and a resolver that fails if anything tries to read it.
	q.ExpectedRevisions = nil
	d.SourceSQL = "SELECT * FROM table_that_does_not_exist"
	o := qt.PlanOptions{Resolver: qt.DefinitionResolverFunc(func(context.Context, string) (qt.ComputedColumn, error) {
		t.Fatal("unexpected definition read")
		return qt.ComputedColumn{}, nil
	})}
	if _, e = qt.ExecuteV2Rows(context.Background(), tx, d, []map[string]any{{}}, q, o); e != nil {
		t.Fatal(e)
	}
}

func TestRowsArraySurrogatesFallback(t *testing.T) {
	s := rowsSchema()
	field := s.Fields["tags"]
	field.ArrayCaseSensitive = true
	s.Fields["tags"] = field
	cases := []struct {
		name, tags      string
		fallback, match bool
	}{
		{name: "high surrogate", tags: `["\ud800"]`, fallback: true},
		{name: "last high surrogate", tags: `["\uDBFF"]`, fallback: true},
		{name: "low surrogate", tags: `["\udc00"]`, fallback: true},
		{name: "last low surrogate", tags: `["\uDFFF"]`, fallback: true},
		{name: "unpaired before scalar", tags: `["\ud800\u0061"]`, fallback: true},
		{name: "unpaired before pair", tags: `["\ud800\ud83d\ude42"]`, fallback: true},
		{name: "unpaired after backslashes", tags: `["\\\\\ud800"]`, fallback: true},
		{name: "paired surrogates", tags: `["\ud83d\ude42"]`},
		{name: "escaped backslash", tags: `["\\ud800"]`},
		{name: "literal replacement", tags: `["�"]`, match: true},
		{name: "escaped replacement", tags: `["\ufffd"]`, match: true},
		{name: "non-string array", tags: `["\ud800",null]`},
		{name: "invalid JSON", tags: `["\ud800`},
	}
	rows := make([]map[string]any, len(cases))
	for i, c := range cases {
		rows[i] = map[string]any{"id": c.name, "tags": c.tags}
	}
	db := openRowsDB(t)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	stageMemoryRows(t, tx, s, rows)
	where := []qt.WhereTerm{{Field: "tags", Op: "includes", Value: "�"}}
	filter, err := qt.CompileRowFilter(where, s, qt.SQLiteOptions{})
	if err != nil {
		t.Fatal(err)
	}
	sqlFilter, err := qt.CompileSQLiteWhere(where, s, qt.SQLiteOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var count int
			args := append([]any{c.name}, sqlFilter.Args...)
			if err := tx.QueryRow("SELECT COUNT(*) FROM memory AS r WHERE id=? AND "+sqlFilter.SQL, args...).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if (count == 1) != c.match {
				t.Fatalf("SQLite match = %v, want %v", count == 1, c.match)
			}
			match, err := filter.Match(rows[i])
			if c.fallback {
				if match || !errors.Is(err, qt.ErrRowsUnsupported) {
					t.Fatalf("Match = %v, %v; want false, ErrRowsUnsupported", match, err)
				}
			} else if err != nil || match != c.match {
				t.Fatalf("Match = %v, %v; want %v, nil", match, err, c.match)
			}
		})
	}
	q := qt.MetricQuery{Version: 2, Where: where, Metrics: []qt.AggSpec{{ID: "count", Op: "count"}}}
	d := qt.SQLiteV2Dataset{Schema: s, SourceSQL: "SELECT * FROM memory"}
	out, err := qt.ExecuteV2Rows(context.Background(), tx, d, rows, q, qt.PlanOptions{})
	if !errors.Is(err, qt.ErrRowsUnsupported) || out.Rows != nil || out.Metrics != nil {
		t.Fatalf("ExecuteV2Rows = %+v, %v; want empty result, ErrRowsUnsupported", out, err)
	}
}
