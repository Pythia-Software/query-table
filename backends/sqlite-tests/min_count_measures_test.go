package sqlitetests

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

// Requests 10 and 11 from Pharos: a minimum over distinct values and over a
// summed field. /metrics (ExecuteV2), /query-v3 (Execute) and ExecuteV2Rows
// must agree; the same scenarios run in-process in
// packages/core/test/metricPopulation.test.ts.
const measuredMinimumDDL = `CREATE TABLE usage(id TEXT,model_family TEXT,conversation_id TEXT,cost INTEGER);
WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<39)
INSERT INTO usage SELECT 'o'||i,'opus','c'||(i%3),1 FROM n;
WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<5)
INSERT INTO usage SELECT 'h'||i,'haiku','h'||i,2 FROM n;
INSERT INTO usage VALUES('x','haiku',NULL,1);
CREATE TABLE tools(id TEXT,tool_name TEXT,call_count INTEGER,failures INTEGER);
INSERT INTO tools VALUES('g1','grep',3,1),('g2','grep',3,0),('g3','grep',3,1),('g4','grep',NULL,0),('r1','read',4,1),('r2','read',4,0),('r3','read',4,2);`

func measuredMinimumSchemas() (usage, tools qt.Schema) {
	text := func(name string) qt.FieldSpec {
		return qt.FieldSpec{Name: name, Kind: qt.FieldText, Expr: "r." + name, Sortable: true, ServerFilter: true}
	}
	number := func(name string) qt.FieldSpec {
		return qt.FieldSpec{Name: name, Kind: qt.FieldNumber, Expr: "r." + name, ExpressionNumeric: true, Sortable: true, ServerFilter: true}
	}
	usage = qt.Schema{Name: "usage", IDField: "id", Fields: map[string]qt.FieldSpec{
		"id": text("id"), "model_family": text("model_family"), "conversation_id": text("conversation_id"), "cost": number("cost"),
	}}
	tools = qt.Schema{Name: "tools", IDField: "id", Fields: map[string]qt.FieldSpec{
		"id": text("id"), "tool_name": text("tool_name"), "call_count": number("call_count"), "failures": number("failures"),
	}}
	return usage, tools
}

// measuredMinimumEngines runs one metric through /metrics and /query-v3, and
// through ExecuteV2Rows when rows are given, and requires identical results.
func measuredMinimumEngines(t *testing.T, db *sql.DB, s qt.Schema, table string, spec qt.AggSpec, rows bool) qt.SQLiteMetricV2 {
	t.Helper()
	ctx := context.Background()
	v2 := qt.SQLiteV2Dataset{Schema: s, SourceSQL: "SELECT * FROM " + table, Scope: "one", Dataset: table}
	q := qt.MetricQuery{Version: 2, Profile: qt.SQLiteExpressionProfile, Limit: 100, Metrics: []qt.AggSpec{spec}}
	metrics, err := v2.ExecuteV2(ctx, db, nil, &q, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	want := metrics.Metrics.Metrics[0]
	if want.Error != "" {
		t.Fatalf("/metrics: %s", want.Error)
	}
	v3 := qt.QueryDatasetV3{Schema: s, SourceSQL: "SELECT * FROM " + table, Dialect: "sqlite", Scope: "one", Dataset: table}
	if caps := v3.Capabilities(); !caps.MetricMinCountMeasures {
		t.Fatalf("v3 capabilities: %#v", caps)
	}
	out, err := v3.Execute(ctx, db, qt.QueryRequestV3{Version: 3, Profile: qt.SQLiteExpressionProfile, Metrics: []qt.AggSpec{spec},
		Source: qt.WireQuery{Limit: 100}, Result: qt.WireQuery{Limit: 100}}, qt.PlanOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := json.Marshal(out.Metrics[0]); string(got) != mustJSON(t, want) {
		t.Fatalf("/query-v3 %s\n/metrics  %s", got, mustJSON(t, want))
	}
	if rows {
		data := []map[string]any{}
		r, err := db.Query("SELECT * FROM " + table)
		if err != nil {
			t.Fatal(err)
		}
		columns, _ := r.Columns()
		for r.Next() {
			values := make([]any, len(columns))
			pointers := make([]any, len(columns))
			for i := range values {
				pointers[i] = &values[i]
			}
			if err = r.Scan(pointers...); err != nil {
				t.Fatal(err)
			}
			row := map[string]any{}
			for i, c := range columns {
				row[c] = values[i]
			}
			data = append(data, row)
		}
		r.Close()
		memory, err := qt.ExecuteV2Rows(ctx, nil, v2, data, q, qt.PlanOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if got := mustJSON(t, memory.Metrics.Metrics[0]); got != mustJSON(t, want) {
			t.Fatalf("ExecuteV2Rows %s\n/metrics      %s", got, mustJSON(t, want))
		}
	}
	return want
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func summarize(m qt.SQLiteMetricV2) string {
	parts := []string{}
	for _, b := range m.Buckets {
		parts = append(parts, fmt.Sprintf("%v:%d:%v", b.Keys[0], b.Count, b.Value))
	}
	hidden := "nil"
	if m.HiddenGroups != nil {
		hidden = fmt.Sprint(*m.HiddenGroups)
	}
	return fmt.Sprintf("groups=%d hidden=%s %s", m.GroupCount, hidden, strings.Join(parts, " "))
}

func TestMinCountDistinctConversations(t *testing.T) {
	db := hookedDB(t, &statementLog{}, measuredMinimumDDL)
	usage, _ := measuredMinimumSchemas()
	spec := qt.AggSpec{ID: "cost", Op: "sum", Field: "cost", GroupBy: []string{"model_family"}, MinCount: qt.MetricMinCount{Min: 5, Distinct: "conversation_id"}}
	// opus: 40 records in 3 conversations; haiku: 6 conversations (and a null).
	if got := summarize(measuredMinimumEngines(t, db, usage, "usage", spec, true)); got != "groups=1 hidden=1 haiku:7:13" {
		t.Fatal(got)
	}
	spec.MinCount = qt.MetricMinCount{Min: 5}
	if got := summarize(measuredMinimumEngines(t, db, usage, "usage", spec, true)); got != "groups=2 hidden=0 opus:40:40 haiku:7:13" {
		t.Fatal(got)
	}
	spec.MinCount = qt.MetricMinCount{Min: 7, Distinct: "conversation_id"}
	if got := summarize(measuredMinimumEngines(t, db, usage, "usage", spec, true)); got != "groups=0 hidden=2 " {
		t.Fatal(got)
	}
}

func TestMinCountSummedCalls(t *testing.T) {
	db := hookedDB(t, &statementLog{}, measuredMinimumDDL)
	_, tools := measuredMinimumSchemas()
	rate := qt.AggSpec{ID: "rate", Op: "count", Expression: "SUM([failures]) / SUM([call_count])", GroupBy: []string{"tool_name"}}
	all := measuredMinimumEngines(t, db, tools, "tools", rate, false)
	rate.MinCount = qt.MetricMinCount{Min: 10, Sum: "call_count"}
	kept := measuredMinimumEngines(t, db, tools, "tools", rate, false)
	// grep's rows hold 9 calls; read's 3 rows hold 12.
	if got := summarize(kept); got != "groups=1 hidden=1 read:3:0.25" {
		t.Fatal(got)
	}
	if !reflect.DeepEqual(kept.Buckets[0], all.Buckets[0]) || all.Buckets[0].Keys[0] != "read" || len(all.Buckets) != 2 {
		t.Fatalf("kept value changed: %v / %v", kept.Buckets, all.Buckets)
	}
	// ExecuteV2Rows runs single aggregates.
	failures := qt.AggSpec{ID: "failures", Op: "sum", Field: "failures", GroupBy: []string{"tool_name"}, MinCount: qt.MetricMinCount{Min: 10, Sum: "call_count"}, GroupLimit: 1}
	if got := summarize(measuredMinimumEngines(t, db, tools, "tools", failures, true)); got != "groups=1 hidden=1 read:3:3" {
		t.Fatal(got)
	}
	// By rows, grep (4 rows) is kept and read (3 rows) hidden.
	failures.MinCount = qt.MetricMinCount{Min: 4}
	if got := summarize(measuredMinimumEngines(t, db, tools, "tools", failures, true)); got != "groups=1 hidden=1 grep:4:2" {
		t.Fatal(got)
	}
}

// Fused and cross-field reductions supply each member's minimum measure; the
// batch must match each metric run alone.
func TestMinCountMeasuresInFusedReductions(t *testing.T) {
	log := &statementLog{}
	db := hookedDB(t, log, measuredMinimumDDL)
	_, tools := measuredMinimumSchemas()
	d := qt.SQLiteV2Dataset{Schema: tools, SourceSQL: "SELECT * FROM tools", Scope: "one", Dataset: "tools"}
	group := []string{"tool_name"}
	q := qt.MetricQuery{Version: 2, Profile: qt.SQLiteExpressionProfile, Limit: 100, Metrics: []qt.AggSpec{
		{ID: "rows", Op: "count", GroupBy: group},
		{ID: "failures", Op: "sum", Field: "failures", GroupBy: group, MinCount: qt.MetricMinCount{Min: 10, Sum: "call_count"}},
		{ID: "calls", Op: "sum", Field: "call_count", GroupBy: group, MinCount: qt.MetricMinCount{Min: 10, Sum: "call_count"}},
		{ID: "distinct", Op: "avg", Field: "failures", GroupBy: group, MinCount: qt.MetricMinCount{Min: 4, Distinct: "id"}},
		{ID: "plain", Op: "max", Field: "failures", GroupBy: group, MinCount: qt.MetricMinCount{Min: 4}},
	}}
	got := crossFieldParity(t, db, d, q, qt.PlanOptions{})
	summary := []string{}
	for _, m := range got.Metrics.Metrics {
		summary = append(summary, m.ID+" "+summarize(m))
	}
	want := []string{
		"rows groups=2 hidden=nil grep:4:4 read:3:3",
		"failures groups=1 hidden=1 read:3:3",
		"calls groups=1 hidden=1 read:3:12",
		"distinct groups=1 hidden=1 grep:4:0.5",
		"plain groups=1 hidden=1 grep:4:1",
	}
	if !reflect.DeepEqual(summary, want) {
		t.Fatalf("got  %q\nwant %q", summary, want)
	}
	log.reset(nil)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = d.ExecuteV2In(context.Background(), tx, nil, &q, qt.PlanOptions{}); err != nil {
		t.Fatal(err)
	}
	if n := log.count("CREATE TEMP TABLE _qt_reduction_"); n != 1 {
		t.Fatalf("%d reductions, want one shared reduction", n)
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	// Integer storage takes the checked integer reduction, measures included.
	q.Metrics = q.Metrics[:3]
	log.reset(nil)
	crossFieldParity(t, db, d, q, qt.PlanOptions{})
	if log.count("qt_integer_valid") == 0 {
		t.Fatal("integer reduction not attempted")
	}
}
