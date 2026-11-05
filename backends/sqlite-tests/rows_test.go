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
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// These fixtures once compared the in-memory ExecuteV2Rows engine with SQL.
// That engine is gone; the same fixtures, staged into a SQLite table, now
// compare v3's direct (ungrouped) execution with its staged executor.

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

// memoryRowValues is the storage contract of the removed qt.SQLiteRowValues:
// bools bind as 0/1, NaN and empty datetimes as NULL; other values as given.
func memoryRowValues(row map[string]any, s qt.Schema, columns []string) ([]any, error) {
	values := make([]any, len(columns))
	for i, name := range columns {
		f, ok := s.Fields[name]
		if !ok {
			return nil, fmt.Errorf("unknown staging field %q", name)
		}
		v := row[name]
		switch n := v.(type) {
		case nil, int64, string:
		case float64:
			if math.IsNaN(n) {
				v = nil
			}
		case bool:
			if f.Kind != qt.FieldBool {
				return nil, fmt.Errorf("unsupported %T in field %s", v, name)
			}
			v = int64(0)
			if n {
				v = int64(1)
			}
		default:
			return nil, fmt.Errorf("unsupported %T in field %s", v, name)
		}
		if f.Kind == qt.FieldDatetime && v == "" {
			v = nil
		}
		values[i] = v
	}
	return values, nil
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
	if _, e := tx.Exec("DROP TABLE IF EXISTS temp.memory; CREATE TEMP TABLE memory (" + strings.Join(quoted, ",") + ")"); e != nil {
		tb.Fatal(e)
	}
	stmt, e := tx.Prepare("INSERT INTO memory VALUES (" + strings.Join(marks, ",") + ")")
	if e != nil {
		tb.Fatal(e)
	}
	defer stmt.Close()
	for _, row := range rows {
		values, e := memoryRowValues(row, s, columns)
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

// compareStaged requires direct and staged v3 execution of q to agree,
// including on request errors.
func compareStaged(tb testing.TB, tx *sql.Tx, d qt.QueryDatasetV3, q qt.QueryRequestV3, o qt.PlanOptions) {
	tb.Helper()
	got, ge := qt.TestOnlyStageUngrouped(d).ExecuteIn(context.Background(), tx, q, o)
	want, we := d.ExecuteIn(context.Background(), tx, q, o)
	var diag *qt.PlanDiagnostic
	if we == nil && errors.As(ge, &diag) && diag.Code == "invalid_source_value" {
		// Staging validates the whole copied source and refuses invalid
		// storage; direct execution reports it per metric bucket instead.
		for _, m := range want.Metrics {
			for _, b := range m.Buckets {
				if b.Error != "" {
					return
				}
			}
		}
		tb.Fatalf("staged refused invalid storage that direct execution did not report: %s", mustJSON(tb, want))
	}
	if ge != nil || we != nil {
		if fmt.Sprint(ge) != fmt.Sprint(we) {
			tb.Fatalf("errors: staged %v direct %v", ge, we)
		}
		return
	}
	gb, _ := json.Marshal(got)
	wb, _ := json.Marshal(want)
	if string(gb) != string(wb) {
		tb.Fatalf("query %+v\nstaged %s\ndirect %s", q, gb, wb)
	}
}

// assertStagedPopulationBudget checks a population budget below the source
// binds only staged execution: direct metrics read SourceSQL and ignore it.
func assertStagedPopulationBudget(tb testing.TB, tx *sql.Tx, d qt.QueryDatasetV3, q qt.QueryRequestV3, o qt.PlanOptions) {
	tb.Helper()
	unlimited := d
	unlimited.MaxPopulation = 0
	want, we := unlimited.ExecuteIn(context.Background(), tx, q, o)
	got, ge := d.ExecuteIn(context.Background(), tx, q, o)
	if fmt.Sprint(ge) != fmt.Sprint(we) || mustJSON(tb, got) != mustJSON(tb, want) {
		tb.Fatalf("direct execution applied the population budget: %v %v", ge, we)
	}
	var diag *qt.PlanDiagnostic
	if _, err := qt.TestOnlyStageUngrouped(d).ExecuteIn(context.Background(), tx, q, o); we == nil && (!errors.As(err, &diag) || diag.Code != "resource_limit") {
		tb.Fatalf("staged population budget ignored: %v", err)
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
	d := qt.QueryDatasetV3{Dialect: "sqlite", Schema: s, SourceSQL: "SELECT * FROM memory"}
	rng := rand.New(rand.NewSource(160))
	for i := 0; i < 80; i++ {
		q := metricsV3(nil, nil, 0, 0)
		if i%3 == 0 {
			q.Result.Where = []qt.WhereTerm{{Any: []qt.WhereClause{{Field: "n", Op: ">", Value: "0"}, {Field: "text", Op: "contains", Value: "é"}}}}
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
			if len(spec.GroupBy) > 0 && i%6 == 3 {
				spec.MinCount = []qt.MetricMinCount{{Min: 2, Distinct: "text"}, {Min: 2, Sum: "n"}, {Min: 1, Distinct: "stamp"}}[j%3]
			}
			if len(spec.GroupBy) > 0 && i%6 == 0 {
				spec.MinCount = qt.MetricMinCount{Min: 3}
			}
			if i%7 == 0 {
				spec.GroupLimit = 2
			}
			if i%2 == 0 {
				spec.Sort = []qt.MetricSort{{Key: "count", Dir: "asc"}, {Key: "value", Dir: "desc", Nulls: "first"}}
			}
			q.Metrics = append(q.Metrics, spec)
		}
		compareStaged(t, tx, d, q, qt.PlanOptions{})
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
			d := qt.QueryDatasetV3{Dialect: "sqlite", Schema: s, SourceSQL: "SELECT * FROM memory"}
			q := metricsV3(nil, nil, 0, 0, qt.AggSpec{ID: "sum", Op: "sum", Field: "n"}, qt.AggSpec{ID: "avg", Op: "avg", Field: "n"}, qt.AggSpec{ID: "min", Op: "min", Field: "n"}, qt.AggSpec{ID: "max", Op: "max", Field: "n"}, qt.AggSpec{ID: "count", Op: "count", Field: "n"}, qt.AggSpec{ID: "distinct", Op: "count_distinct", Field: "n"}, qt.AggSpec{ID: "groups", Op: "count", GroupBy: []string{"text"}})
			compareStaged(t, tx, d, q, qt.PlanOptions{})
			d.MaxPopulation = 1
			// v3 applies MaxPopulation to staged execution only.
			if len(rows) > 1 {
				assertStagedPopulationBudget(t, tx, d, q, qt.PlanOptions{})
			} else {
				compareStaged(t, tx, d, q, qt.PlanOptions{})
			}
			d.MaxPopulation = 0
			d.MaxGroups = 1
			compareStaged(t, tx, d, q, qt.PlanOptions{})
			q.Metrics[6].MinCount = qt.MetricMinCount{Min: 2}
			compareStaged(t, tx, d, q, qt.PlanOptions{})
			q.Metrics[6].MinCount = qt.MetricMinCount{Min: 2, Sum: "n"}
			compareStaged(t, tx, d, q, qt.PlanOptions{})
			q.Metrics[6].MinCount = qt.MetricMinCount{Min: 1, Distinct: "n"}
			compareStaged(t, tx, d, q, qt.PlanOptions{})
		})
	}
}

// 50,000 rows staged into a SQLite table, then reduced directly by v3.
func BenchmarkV2RowsTokenSummary(b *testing.B) {
	s := rowsSchema()
	rows := make([]map[string]any, 50000)
	for i := range rows {
		rows[i] = map[string]any{"id": fmt.Sprint(i), "enum": []string{"a", "b", "c"}[i%3], "n": int64(i % 1000), "n2": float64(i%700) / 100, "n3": int64(i % 20), "n4": int64(i % 40), "n5": int64(i % 60), "text": fmt.Sprint(i % 700)}
	}
	q := metricsV3(nil, nil, 0, 0, qt.AggSpec{ID: "1", Op: "sum", Field: "n"}, qt.AggSpec{ID: "2", Op: "sum", Field: "n2"}, qt.AggSpec{ID: "3", Op: "sum", Field: "n3"}, qt.AggSpec{ID: "4", Op: "sum", Field: "n4"}, qt.AggSpec{ID: "5", Op: "sum", Field: "n5"}, qt.AggSpec{ID: "sessions", Op: "count_distinct", Field: "text"})
	db := openRowsDB(b)
	d := qt.QueryDatasetV3{Dialect: "sqlite", Schema: s, SourceSQL: "SELECT * FROM memory"}
	for _, filtered := range []bool{false, true} {
		name := "unfiltered"
		if filtered {
			name = "filtered"
			q.Result.Where = []qt.WhereTerm{{Field: "enum", Op: "!=", Value: "b"}}
		}
		b.Run(name+"/staged", func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				tx, e := db.Begin()
				if e != nil {
					b.Fatal(e)
				}
				stageMemoryRows(b, tx, s, rows)
				_, e = d.ExecuteIn(context.Background(), tx, q, qt.PlanOptions{})
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
	d := qt.QueryDatasetV3{Dialect: "sqlite", Schema: s, SourceSQL: "SELECT * FROM memory"}
	base := metricsV3(nil, nil, 0, 0, qt.AggSpec{ID: "m", Op: "count"})
	for _, change := range []func(*qt.QueryRequestV3){
		func(q *qt.QueryRequestV3) { q.Version = 1 }, func(q *qt.QueryRequestV3) { q.Profile = "other" }, func(q *qt.QueryRequestV3) { q.PlanToken = "invalid" }, func(q *qt.QueryRequestV3) { q.Snapshot = "invalid" }, func(q *qt.QueryRequestV3) { q.Result.Limit = 10001 }, func(q *qt.QueryRequestV3) {
			q.Metrics = []qt.AggSpec{{ID: "same", Op: "count"}, {ID: "same", Op: "count"}}
		}, func(q *qt.QueryRequestV3) { q.Result.Where = []qt.WhereTerm{{Field: "missing", Op: "=", Value: "x"}} },
	} {
		q := base
		change(&q)
		var diag *qt.PlanDiagnostic
		if _, err := d.ExecuteIn(context.Background(), tx, q, qt.PlanOptions{}); !errors.As(err, &diag) {
			t.Fatalf("invalid request accepted: %+v %v", q, err)
		}
		compareStaged(t, tx, d, q, qt.PlanOptions{})
	}
	// Invalid clauses retain the adapter's per-metric failure envelopes.
	q := base
	q.Metrics = []qt.AggSpec{{ID: "good", Op: "count"}, {ID: "bad", Op: "sum", Field: "text"}, {ID: "sort", Op: "count", Sort: []qt.MetricSort{{Key: "wrong", Dir: "asc"}}}, {ID: "min", Op: "count", MinCount: qt.MetricMinCount{Min: 2}}, {ID: "regex", Op: "count", Where: []qt.WhereTerm{{Field: "text", Op: "matches_regex", Value: "x"}}}}
	compareStaged(t, tx, d, q, qt.PlanOptions{})
	calls := 0
	resolver := qt.DefinitionResolverFunc(func(_ context.Context, id string) (qt.ComputedColumn, error) {
		calls++
		return qt.ComputedColumn{ID: id, Label: "Test", Revision: "1", Expression: qt.ComputedExpression{Language: "qt-expr", Version: 1, Source: "[n]*2"}}, nil
	})
	o := qt.PlanOptions{Resolver: resolver}
	q = base
	q.ExpectedRevisions = map[string]string{"hidden": "1"}
	compareStaged(t, tx, d, q, o)
	q.ExpectedRevisions = map[string]string{"hidden": "stale"}
	compareStaged(t, tx, d, q, o)
	d.MaxPopulation = 1
	assertStagedPopulationBudget(t, tx, d, q, o)
	d.MaxPopulation = 0
	q.ExpectedRevisions = map[string]string{"": "1"}
	compareStaged(t, tx, d, q, o)
	if calls == 0 {
		t.Fatal("unused revisions were not verified")
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e = d.ExecuteIn(canceled, tx, base, qt.PlanOptions{}); !errors.Is(e, context.Canceled) {
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
	d := qt.QueryDatasetV3{Dialect: "sqlite", Schema: s, SourceSQL: "SELECT * FROM memory"}
	// Staging refuses this invalid storage outright (invalid_source_value) and
	// the in-memory reference engine is gone, so direct filtering over mixed
	// storage (numeric text, integers beyond 2^53, NaN, -Inf, numbers in a
	// text field) is pinned to its current results, which v2 shared.
	counts := []string{}
	for _, field := range []string{"n", "text"} {
		for _, op := range []string{"=", "!=", ">", "<", ">=", "<="} {
			for _, v := range []string{"9007199254740992", "9007199254740994", "5"} {
				q := metricsV3([]qt.WhereTerm{{Field: field, Op: op, Value: v}}, nil, 0, 0, qt.AggSpec{ID: "m", Op: "count"})
				r, err := d.ExecuteIn(context.Background(), tx, q, qt.PlanOptions{})
				if err != nil {
					counts = append(counts, fmt.Sprintf("%s%s%s:%v", field, op, v, err))
					continue
				}
				counts = append(counts, fmt.Sprintf("%s%s%s=%d", field, op, v, r.Metrics[0].Buckets[0].Count))
			}
		}
	}
	if got := strings.Join(counts, " "); got != storageComparisonCounts {
		t.Fatalf("got  %s\nwant %s", got, storageComparisonCounts)
	}
}

const storageComparisonCounts = `n=9007199254740992=1 n=9007199254740994=0 n=5=0 n!=9007199254740992=4 n!=9007199254740994=5 n!=5=5 n>9007199254740992=2 n>9007199254740994=1 n>5=3 n<9007199254740992=1 n<9007199254740994=3 n<5=1 n>=9007199254740992=3 n>=9007199254740994=1 n>=5=3 n<=9007199254740992=2 n<=9007199254740994=3 n<=5=1 text=9007199254740992=0 text=9007199254740994=0 text=5=0 text!=9007199254740992=5 text!=9007199254740994=5 text!=5=5 text>9007199254740992:filter: field "text": op ">" is not enabled text>9007199254740994:filter: field "text": op ">" is not enabled text>5:filter: field "text": op ">" is not enabled text<9007199254740992:filter: field "text": op "<" is not enabled text<9007199254740994:filter: field "text": op "<" is not enabled text<5:filter: field "text": op "<" is not enabled text>=9007199254740992:filter: field "text": op ">=" is not enabled text>=9007199254740994:filter: field "text": op ">=" is not enabled text>=5:filter: field "text": op ">=" is not enabled text<=9007199254740992:filter: field "text": op "<=" is not enabled text<=9007199254740994:filter: field "text": op "<=" is not enabled text<=5:filter: field "text": op "<=" is not enabled`

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
	d := qt.QueryDatasetV3{Dialect: "sqlite", Schema: s, SourceSQL: "SELECT * FROM memory"}
	q := metricsV3(nil, nil, 0, 0)
	for _, field := range []string{"stamp", "millis", "unix"} {
		for _, op := range []string{"count", "count_distinct", "min", "max"} {
			q.Metrics = append(q.Metrics, qt.AggSpec{ID: field + op, Field: field, Op: op})
		}
	}
	compareStaged(t, tx, d, q, qt.PlanOptions{})
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
	d := qt.QueryDatasetV3{Dialect: "sqlite", Schema: s, SourceSQL: "SELECT * FROM memory"}
	for _, groups := range [][]string{nil, {"text"}} {
		q := metricsV3(nil, nil, 0, 0)
		for _, field := range []string{"n", "n2"} {
			for _, op := range []string{"sum", "avg"} {
				q.Metrics = append(q.Metrics, qt.AggSpec{ID: op + field, Op: op, Field: field, GroupBy: groups})
			}
		}
		compareStaged(t, tx, d, q, qt.PlanOptions{})
		want := mustJSON(t, executeV3Tx(t, tx, d, q, qt.PlanOptions{}).Metrics)
		// The decimal result is invariant to row visitation order.
		rng.Shuffle(len(rows), func(i, j int) { rows[i], rows[j] = rows[j], rows[i] })
		stageMemoryRows(t, tx, s, rows)
		compareStaged(t, tx, d, q, qt.PlanOptions{})
		if got := mustJSON(t, executeV3Tx(t, tx, d, q, qt.PlanOptions{}).Metrics); got != want {
			t.Fatalf("row order changed decimals:\n%s\n%s", got, want)
		}
	}
}

func TestRowsArraySurrogatesFallback(t *testing.T) {
	s := rowsSchema()
	field := s.Fields["tags"]
	field.ArrayCaseSensitive = true
	s.Fields["tags"] = field
	cases := []struct {
		name, tags string
		match      bool
	}{
		{name: "high surrogate", tags: `["\ud800"]`},
		{name: "last high surrogate", tags: `["\uDBFF"]`},
		{name: "low surrogate", tags: `["\udc00"]`},
		{name: "last low surrogate", tags: `["\uDFFF"]`},
		{name: "unpaired before scalar", tags: `["\ud800a"]`},
		{name: "unpaired before pair", tags: `["\ud800🙂"]`},
		{name: "unpaired after backslashes", tags: `["\\\\\ud800"]`},
		{name: "paired surrogates", tags: `["🙂"]`},
		{name: "escaped backslash", tags: `["\\ud800"]`},
		{name: "literal replacement", tags: `["�"]`, match: true},
		{name: "escaped replacement", tags: `["�"]`, match: true},
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
	d := qt.QueryDatasetV3{Dialect: "sqlite", Schema: s, SourceSQL: "SELECT * FROM memory"}
	where := []qt.WhereTerm{{Field: "tags", Op: "includes", Value: "�"}}
	// SQLite matching through v3; the in-memory matcher's fallback is gone.
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			q := metricsV3(append([]qt.WhereTerm{{Field: "id", Op: "=", Value: c.name}}, where...), nil, 0, 0, qt.AggSpec{ID: "count", Op: "count"})
			count := executeV3Tx(t, tx, d, q, qt.PlanOptions{}).Metrics[0].Buckets[0].Count
			if (count == 1) != c.match {
				t.Fatalf("SQLite match = %v, want %v", count == 1, c.match)
			}
		})
	}
	compareStaged(t, tx, d, metricsV3(where, nil, 0, 0, qt.AggSpec{ID: "count", Op: "count"}), qt.PlanOptions{})
}
