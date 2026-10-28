package sqlitetests

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// A legend selection of combined groups is an OR of ANDs: one term holding a
// {"all": [...]} branch per (provider, model) pair.

var orOfAndsProviders = []string{"anthropic", "openai", "google", "mistral", "meta", "xai"}
var orOfAndsModels = []string{"opus", "sonnet", "haiku", "gpt-5", "mini"}

func orOfAndsRows() []map[string]any {
	rows := []map[string]any{}
	i := 0
	for p, provider := range orOfAndsProviders {
		for m, model := range orOfAndsModels {
			for k := 0; k <= (p+m)%3; k++ {
				rows = append(rows, map[string]any{"id": fmt.Sprintf("r%03d", i), "provider": provider, "model": model, "tokens": int64(10*p + m + k)})
				i++
			}
		}
		// Rows with a missing model or provider never match a pair.
		rows = append(rows, map[string]any{"id": fmt.Sprintf("r%03d", i), "provider": provider, "model": nil, "tokens": int64(1)})
		i++
	}
	rows = append(rows, map[string]any{"id": fmt.Sprintf("r%03d", i), "provider": nil, "model": "opus", "tokens": int64(1)})
	return rows
}

func orOfAndsSchema() qt.Schema {
	yes := true
	return qt.Schema{Name: "calls", IDField: "id", Fields: map[string]qt.FieldSpec{
		"id":       {Name: "id", Kind: qt.FieldText, Expr: "r.id", Sortable: true, ServerFilter: true},
		"provider": {Name: "provider", Kind: qt.FieldEnum, Expr: "r.provider", Sortable: true, ServerFilter: true, Groupable: &yes},
		"model":    {Name: "model", Kind: qt.FieldText, Expr: "r.model", Sortable: true, ServerFilter: true, Groupable: &yes},
		"tokens":   {Name: "tokens", Kind: qt.FieldNumber, Expr: "r.tokens", Sortable: true, ServerFilter: true, ExpressionNumeric: true},
	}}
}

func openOrOfAnds(t *testing.T) (*sql.DB, []map[string]any) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(t.TempDir(), "calls.db")))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec(`CREATE TABLE calls(id TEXT PRIMARY KEY, provider TEXT, model TEXT, tokens INTEGER)`); err != nil {
		t.Fatal(err)
	}
	rows := orOfAndsRows()
	for _, row := range rows {
		if _, err := db.Exec(`INSERT INTO calls VALUES(?,?,?,?)`, row["id"], row["provider"], row["model"], row["tokens"]); err != nil {
			t.Fatal(err)
		}
	}
	return db, rows
}

type orOfAndsPair struct{ provider, model string }

// Ten pairs, including one with no records.
var orOfAndsPairs = []orOfAndsPair{
	{"anthropic", "opus"}, {"anthropic", "haiku"}, {"openai", "gpt-5"}, {"openai", "mini"}, {"google", "sonnet"},
	{"mistral", "opus"}, {"meta", "haiku"}, {"xai", "gpt-5"}, {"xai", "mini"}, {"nobody", "opus"},
}

func orOfAndsTerm(pairs []orOfAndsPair) qt.WhereTerm {
	term := qt.WhereTerm{Any: []qt.WhereClause{}}
	for _, pair := range pairs {
		term.Any = append(term.Any, qt.WhereClause{All: []qt.WhereClause{
			{Field: "provider", Op: "=", Value: pair.provider},
			{Field: "model", Op: "=", Value: pair.model},
		}})
	}
	return term
}

func orOfAndsV3(d qt.QueryDatasetV3, db *sql.DB, t *testing.T, q qt.QueryRequestV3) qt.QueryResultV3 {
	t.Helper()
	q.Version, q.Profile = 3, qt.SQLiteExpressionProfile
	out, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func rowIDs(rows []map[string]any) []string {
	out := []string{}
	for _, row := range rows {
		out = append(out, row["id"].(string))
	}
	sort.Strings(out)
	return out
}

func TestOrOfAndsTenPairsMatchTheUnion(t *testing.T) {
	db, records := openOrOfAnds(t)
	schema := orOfAndsSchema()
	d := qt.QueryDatasetV3{Schema: schema, SourceSQL: "SELECT * FROM calls", Dialect: "sqlite", Scope: "one", Dataset: "calls"}
	term := orOfAndsTerm(orOfAndsPairs)

	// The union of each pair's own records, and each pair's record count.
	union := map[string]bool{}
	perPair := map[orOfAndsPair]int{}
	for _, pair := range orOfAndsPairs {
		out := orOfAndsV3(d, db, t, qt.QueryRequestV3{Rows: true, Result: qt.WireQuery{Select: []string{"id"}, Where: []qt.WhereTerm{
			{Field: "provider", Op: "=", Value: pair.provider}, {Field: "model", Op: "=", Value: pair.model},
		}, Limit: 10000}})
		for _, id := range rowIDs(out.Rows) {
			union[id] = true
		}
		perPair[pair] = len(out.Rows)
	}
	want := []string{}
	for id := range union {
		want = append(want, id)
	}
	sort.Strings(want)
	if len(want) < 15 || perPair[orOfAndsPair{"nobody", "opus"}] != 0 {
		t.Fatalf("fixture too small: %v", want)
	}

	// Source rows on /query-v3: one term selects exactly the union.
	out := orOfAndsV3(d, db, t, qt.QueryRequestV3{Rows: true, Result: qt.WireQuery{Select: []string{"id"}, Where: []qt.WhereTerm{term}, Limit: 10000}})
	if got := rowIDs(out.Rows); !reflect.DeepEqual(got, want) || out.Total != int64(len(want)) {
		t.Fatalf("rows %v (total %d), want %v", got, out.Total, want)
	}

	// The same term as a JSON request body, as a host receives it.
	body, err := json.Marshal(qt.WireQuery{Where: []qt.WhereTerm{term}})
	if err != nil {
		t.Fatal(err)
	}
	var decoded qt.WireQuery
	if err := json.Unmarshal(body, &decoded); err != nil || !reflect.DeepEqual(decoded.Where, []qt.WhereTerm{term}) {
		t.Fatalf("JSON round trip %s: %v %#v", body, err, decoded.Where)
	}

	// Grouped rows: a source filter, and the same term as a group filter.
	grouped := func(source, result []qt.WhereTerm) map[orOfAndsPair]float64 {
		out := orOfAndsV3(d, db, t, qt.QueryRequestV3{Rows: true,
			Source:   qt.WireQuery{Where: source},
			Grouping: &qt.GroupingDefinition{Keys: []string{"provider", "model"}, Summaries: []qt.SummaryColumn{{ID: "num", Op: "count"}}},
			Result:   qt.WireQuery{Select: []string{"provider", "model", "num"}, Where: result, Limit: 1000},
		})
		groups := map[orOfAndsPair]float64{}
		for _, row := range out.Rows {
			provider, _ := row["provider"].(string)
			model, _ := row["model"].(string)
			groups[orOfAndsPair{provider, model}] = row["num"].(float64)
		}
		return groups
	}
	wantGroups := map[orOfAndsPair]float64{}
	for pair, n := range perPair {
		if n > 0 {
			wantGroups[pair] = float64(n)
		}
	}
	if got := grouped([]qt.WhereTerm{term}, nil); !reflect.DeepEqual(got, wantGroups) {
		t.Fatalf("source filter groups %v, want %v", got, wantGroups)
	}
	if got := grouped(nil, []qt.WhereTerm{term}); !reflect.DeepEqual(got, wantGroups) {
		t.Fatalf("group filter groups %v, want %v", got, wantGroups)
	}

	// /metrics: the metric's own where, and the query population.
	v2 := qt.SQLiteV2Dataset{Schema: schema, SourceSQL: "SELECT * FROM calls", Scope: "one", Dataset: "calls"}
	metrics := func(q qt.MetricQuery) []qt.SQLiteMetricV2 {
		q.Version, q.Profile = 2, qt.SQLiteExpressionProfile
		r, err := v2.ExecuteV2(context.Background(), db, nil, &q, qt.PlanOptions{})
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range r.Metrics.Metrics {
			if m.Error != "" {
				t.Fatal(m.ID, m.Error)
			}
		}
		return r.Metrics.Metrics
	}
	count := func(m qt.SQLiteMetricV2) int64 { return m.Buckets[0].Count }
	pairCounts := func(m qt.SQLiteMetricV2) map[orOfAndsPair]float64 {
		out := map[orOfAndsPair]float64{}
		for _, b := range m.Buckets {
			out[orOfAndsPair{fmt.Sprint(b.Keys[0]), fmt.Sprint(b.Keys[1])}] = float64(b.Count)
		}
		return out
	}
	scoped := metrics(qt.MetricQuery{Metrics: []qt.AggSpec{
		{ID: "all", Op: "count"},
		{ID: "selected", Op: "count", Where: []qt.WhereTerm{term}},
		{ID: "pairs", Op: "count", GroupBy: []string{"provider", "model"}, Where: []qt.WhereTerm{term}},
	}})
	if count(scoped[0]) != int64(len(records)) || count(scoped[1]) != int64(len(want)) || !reflect.DeepEqual(pairCounts(scoped[2]), wantGroups) {
		t.Fatalf("metric where: %+v", scoped)
	}
	population := metrics(qt.MetricQuery{Where: []qt.WhereTerm{term}, Metrics: []qt.AggSpec{
		{ID: "selected", Op: "count"},
		{ID: "pairs", Op: "count", GroupBy: []string{"provider", "model"}},
	}})
	if count(population[0]) != int64(len(want)) || !reflect.DeepEqual(pairCounts(population[1]), wantGroups) {
		t.Fatalf("population: %+v", population)
	}

	// ExecuteV2Rows over the same records in memory agrees with SQL.
	memory := qt.SQLiteV2Dataset{Schema: schema, SourceSQL: "SELECT * FROM calls"}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	negated := qt.WhereTerm{Any: []qt.WhereClause{
		{All: []qt.WhereClause{{Field: "provider", Op: "=", Value: "openai"}, {Field: "model", Op: "contains", Value: "gpt", Negated: true}}},
		{Field: "tokens", Op: ">", Value: "50"},
		{All: []qt.WhereClause{{Field: "provider", Op: "=", Value: "meta"}, {Field: "model", Op: "contains", Value: ""}}},
	}}
	for _, q := range []qt.MetricQuery{
		{Where: []qt.WhereTerm{term}, Metrics: []qt.AggSpec{{ID: "n", Op: "count"}, {ID: "pairs", Op: "sum", Field: "tokens", GroupBy: []string{"provider", "model"}}}},
		{Metrics: []qt.AggSpec{{ID: "n", Op: "count", Where: []qt.WhereTerm{term}}, {ID: "by", Op: "count", GroupBy: []string{"model"}, Where: []qt.WhereTerm{term, {Field: "tokens", Op: ">=", Value: "20"}}}}},
		{Where: []qt.WhereTerm{negated}, Metrics: []qt.AggSpec{{ID: "n", Op: "count"}, {ID: "by", Op: "count", GroupBy: []string{"provider", "model"}}}},
	} {
		q.Version, q.Profile = 2, qt.SQLiteExpressionProfile
		got, gotErr := qt.ExecuteV2Rows(context.Background(), tx, memory, records, q, qt.PlanOptions{})
		sqlResult, sqlErr := memory.ExecuteV2In(context.Background(), tx, nil, &q, qt.PlanOptions{})
		if gotErr != nil || sqlErr != nil {
			t.Fatalf("memory %v SQL %v", gotErr, sqlErr)
		}
		gb, _ := json.Marshal(got)
		wb, _ := json.Marshal(sqlResult)
		if string(gb) != string(wb) {
			t.Fatalf("memory %s\nSQL    %s", gb, wb)
		}
	}

	// A negated literal stays null-exclusive inside a branch: an openai row
	// with no model matches neither "contains gpt" nor its negation.
	out = orOfAndsV3(d, db, t, qt.QueryRequestV3{Rows: true, Result: qt.WireQuery{Select: []string{"id", "model"}, Where: []qt.WhereTerm{{Any: negated.Any[:1]}}, Limit: 1000}})
	for _, row := range out.Rows {
		if row["model"] == nil {
			t.Fatalf("negated literal matched a NULL model: %v", out.Rows)
		}
	}
	if len(out.Rows) == 0 {
		t.Fatal("negated branch matched nothing")
	}
}

func TestOrOfAndsRejectsMalformedBranches(t *testing.T) {
	db, _ := openOrOfAnds(t)
	d := qt.QueryDatasetV3{Schema: orOfAndsSchema(), SourceSQL: "SELECT * FROM calls", Dialect: "sqlite", Scope: "one", Dataset: "calls"}
	literal := qt.WhereClause{Field: "provider", Op: "=", Value: "xai"}
	for name, term := range map[string]qt.WhereTerm{
		"empty branch":   {Any: []qt.WhereClause{literal, {All: []qt.WhereClause{}}}},
		"nested branch":  {Any: []qt.WhereClause{literal, {All: []qt.WhereClause{literal, {All: []qt.WhereClause{literal}}}}}},
		"branch literal": {Any: []qt.WhereClause{literal, {Field: "model", Op: "=", Value: "x", All: []qt.WhereClause{literal}}}},
	} {
		q := qt.QueryRequestV3{Version: 3, Profile: qt.SQLiteExpressionProfile, Rows: true, Result: qt.WireQuery{Select: []string{"id"}, Where: []qt.WhereTerm{term}, Limit: 10}}
		if _, err := d.Execute(context.Background(), db, q, qt.PlanOptions{}); err == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
	// Literals inside branches count against the predicate budget.
	big := qt.WhereTerm{Any: []qt.WhereClause{}}
	for i := 0; i < 51; i++ {
		big.Any = append(big.Any, qt.WhereClause{All: []qt.WhereClause{literal, {Field: "model", Op: "=", Value: fmt.Sprint(i)}}})
	}
	if err := (qt.WireQuery{Where: []qt.WhereTerm{big}}).Validate(); err == nil {
		t.Fatal("102 literals accepted")
	}
	big.Any = big.Any[:50]
	if err := (qt.WireQuery{Where: []qt.WhereTerm{big}}).Validate(); err != nil {
		t.Fatal(err)
	}
}
