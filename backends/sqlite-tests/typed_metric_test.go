package sqlitetests

import (
	"context"
	"errors"
	"reflect"
	"regexp"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

const typedMetricRows = `DELETE FROM events;
INSERT INTO events VALUES
('1','repo','a',2,'A'),('2','repo','a',3,'a'),('3','repo','a',0,'A'),
('4','Repo','a',4,'a'),('5','Repo','a',NULL,'b'),
('6',NULL,'b',NULL,NULL),('7',NULL,'b',NULL,''),
('8','','b',0,'😀'),('9','','b',0,'😀'),
('10','nul','a',1,'a'||char(0)||'b'),('11','nul','a',1,'a'||char(0)||'c');`

func typedMetricGrouping(q qt.QueryRequestV3) qt.QueryRequestV3 {
	q.Rows = true
	q.Grouping = &qt.GroupingDefinition{Keys: []string{"g1", "g2"}, Summaries: []qt.SummaryColumn{
		{ID: "rate", Op: "formula", Expression: q.Metrics[0].Expression},
		{ID: "distinct", Op: "count_distinct", Field: "m"},
		{ID: "values", Op: "count", Field: "m"},
	}}
	q.Result = qt.WireQuery{Select: []string{"g1", "g2", "rate", "distinct", "values"}, Limit: 200}
	q.Metrics = []qt.AggSpec{{ID: "groups", Op: "count"}}
	return q
}

var textCheck = regexp.MustCompile(`MIN\(qt_v2_field_error\((i\d+),'text'\)\)`)

func TestV3TextCountIntegerReductionParity(t *testing.T) {
	for _, tc := range []struct {
		name, mutation string
		native         bool
	}{
		{"valid binary text", "", true},
		{"signed", "UPDATE events SET n=-n WHERE id='2'", true},
		{"null sums", "UPDATE events SET n=NULL", true},
		{"zero sums", "UPDATE events SET n=0", true},
		{"null distinct", "UPDATE events SET m=NULL", true},
		{"empty", "DELETE FROM events", true},
		{"decimal fallback", "UPDATE events SET n=0.1 WHERE id='1'", false},
		{"unsafe input", "UPDATE events SET n=9007199254740992 WHERE id='1'", false},
		{"unsafe total", "UPDATE events SET n=9007199254740991 WHERE id IN ('1','2')", false},
		{"unsafe cancellation", "UPDATE events SET n=CASE id WHEN '1' THEN 9007199254740991 WHEN '2' THEN -9007199254740991 ELSE n END", false},
		{"numeric text", "UPDATE events SET n='bad' WHERE id='1'", false},
		{"blob text", "UPDATE events SET m=X'6162' WHERE id='1'", false},
		{"invalid UTF8", "UPDATE events SET m=CAST(X'ff' AS TEXT) WHERE id='1'", false},
		{"numeric text storage", "UPDATE events SET m=123 WHERE id='1'", true}, // TEXT affinity stores a valid string.
		{"oversized operand", "UPDATE events SET m=replace(hex(zeroblob(50001)),'0','x') WHERE id='1'", false},
		{"invalid group", "UPDATE events SET g2=X'ff' WHERE id='1'", false},
		{"error precedence", "UPDATE events SET n=1e101,m=CAST(X'ff' AS TEXT) WHERE id='1'", false},
	} {
		for _, grouped := range []bool{false, true} {
			t.Run(tc.name+map[bool]string{false: "/metric", true: "/grouping"}[grouped], func(t *testing.T) {
				ddl, d, q := typedMetricFixture(1)
				log := &statementLog{}
				db := hookedDB(t, log, ddl+typedMetricRows+tc.mutation)
				if grouped {
					q = typedMetricGrouping(q)
				}
				log.reset(nil)
				got, gotErr := d.Execute(context.Background(), db, q, qt.PlanOptions{})
				if tc.native {
					used := false
					for _, statement := range log.seen {
						if strings.HasPrefix(statement, "CREATE TEMP TABLE") && strings.Contains(statement, "qt_integer_input") {
							used = true
							if strings.Contains(statement, "qt_v2_sum(") || strings.Contains(statement, " AS MATERIALIZED (") {
								t.Fatal("text metric retained per-row decimal reduction or materialization")
							}
							// One per-row 'text' check covers every count leaf and the
							// weaker source identity check over the same field.
							for _, match := range textCheck.FindAllStringSubmatch(statement, -1) {
								if strings.Count(statement, match[0]) != 1 || strings.Contains(statement, "qt_v2_field_error("+match[1]+",'source_text')") {
									t.Fatalf("redundant text validation of %s: %s", match[1], statement)
								}
							}
						}
					}
					if !used || log.count("qt_source_budget") != 0 {
						t.Fatal("eligible text counts did not use the direct reduction")
					}
				}
				log.reset(declineDirect)
				want, wantErr := d.Execute(context.Background(), db, q, qt.PlanOptions{})
				if !reflect.DeepEqual(got, want) || (gotErr == nil) != (wantErr == nil) || gotErr != nil && gotErr.Error() != wantErr.Error() {
					t.Fatalf("optimized %#v / %v\ngeneral %#v / %v", got, gotErr, want, wantErr)
				}
				if tc.name == "valid binary text" && !grouped {
					values := map[any]any{}
					for _, bucket := range got.Metrics[0].Buckets {
						values[bucket.Keys[0]] = bucket.Value
					}
					if got.Metrics[0].GroupCount != 5 || values["repo"] != float64(2500) || values["Repo"] != float64(2000) || values[""] != float64(0) || values[nil] != nil || values["nul"] != float64(1000) {
						t.Fatal(got.Metrics)
					}
				}
			})
		}
	}
}

func TestV3TextCountMinimumsAndLimits(t *testing.T) {
	ddl, d, base := typedMetricFixture(1)
	log := &statementLog{}
	db := hookedDB(t, log, ddl+typedMetricRows)
	for _, minimum := range []qt.MetricMinCount{{Min: 2}, {Min: 2, Distinct: "m"}, {Min: 4, Sum: "n"}} {
		q := base
		q.Metrics = append([]qt.AggSpec{}, base.Metrics...)
		q.Metrics[0].MinCount, q.Metrics[0].GroupLimit = minimum, 1
		log.reset(nil)
		got, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
		if err != nil || got.Metrics[0].Error != "" || len(got.Metrics[0].Buckets) != 1 || log.count("qt_integer_input") == 0 {
			t.Fatalf("%#v: %v", got, err)
		}
		log.reset(declineDirect)
		want, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("minimum %#v: got %#v want %#v err=%v", minimum, got, want, err)
		}
	}
	for _, budget := range []string{"population", "bytes", "groups"} {
		limited := d
		switch budget {
		case "population":
			limited.MaxPopulation = 1
		case "bytes":
			limited.MaxStagingBytes = 1
		case "groups":
			limited.MaxGroups = 1
		}
		q := typedMetricGrouping(base)
		log.reset(nil)
		tx, err := db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		out, err := limited.ExecuteIn(context.Background(), tx, q, qt.PlanOptions{})
		var diag *qt.PlanDiagnostic
		if !errors.As(err, &diag) || diag.Code != "resource_limit" || !reflect.DeepEqual(out, qt.QueryResultV3{}) || tempTables(t, tx) != 0 {
			t.Fatalf("%s: %#v / %v", budget, out, err)
		}
		tx.Rollback()
		log.reset(declineDirect)
		_, wantErr := limited.Execute(context.Background(), db, q, qt.PlanOptions{})
		if wantErr == nil || err.Error() != wantErr.Error() {
			t.Fatalf("%s: got %v want %v", budget, err, wantErr)
		}
	}
}

func TestV3TextCountStagedAndEnumInputs(t *testing.T) {
	for _, mode := range []string{"enum", "staged", "staged oversized", "numeric storage", "sidecar", "omitted invalid group"} {
		t.Run(mode, func(t *testing.T) {
			ddl, d, q := typedMetricFixture(1)
			log := &statementLog{}
			db := hookedDB(t, log, ddl+typedMetricRows)
			switch mode {
			case "enum":
				field := d.Schema.Fields["m"]
				field.Kind = qt.FieldEnum
				d.Schema.Fields["m"] = field
			case "staged", "staged oversized":
				q = typedMetricGrouping(q)
				q.Grouping.Representative = &qt.RepresentativeRow{OrderBy: []qt.OrderBy{{Field: "id", Dir: "asc"}}}
				q.Grouping.Summaries = append(q.Grouping.Summaries, qt.SummaryColumn{ID: "picked", Op: "row", Field: "id"})
				q.Result.Select = append(q.Result.Select, "picked")
				if mode == "staged oversized" {
					if _, err := db.Exec("UPDATE events SET m=replace(hex(zeroblob(50001)),'0','x') WHERE id='1'"); err != nil {
						t.Fatal(err)
					}
				}
			case "numeric storage":
				field := d.Schema.Fields["m"]
				field.Expr = "r.n"
				d.Schema.Fields["m"] = field
			case "sidecar":
				field := d.Schema.Fields["m"]
				field.ValueErrorExpr = "CASE WHEN r.id='1' THEN 'text_range' WHEN r.id='2' THEN 'storage_type' END"
				d.Schema.Fields["m"] = field
			case "omitted invalid group":
				q = typedMetricGrouping(q)
				d.MaxGroups = 1
				if _, err := db.Exec("UPDATE events SET m=X'ff' WHERE g1='repo' COLLATE BINARY"); err != nil {
					t.Fatal(err)
				}
			}
			log.reset(nil)
			got, gotErr := d.Execute(context.Background(), db, q, qt.PlanOptions{})
			if (mode == "enum" || mode == "staged") && log.count("qt_integer_input") == 0 {
				t.Fatal("text counts did not use the native reduction")
			}
			log.reset(declineDirect)
			want, wantErr := d.Execute(context.Background(), db, q, qt.PlanOptions{})
			if !reflect.DeepEqual(got, want) || (gotErr == nil) != (wantErr == nil) || gotErr != nil && gotErr.Error() != wantErr.Error() {
				t.Fatalf("optimized %#v / %v\ngeneral %#v / %v", got, gotErr, want, wantErr)
			}
		})
	}
}

func TestV3TextCountOpaqueSourceAndSidecars(t *testing.T) {
	for _, sidecar := range []bool{false, true} {
		ddl, d, q := typedMetricFixture(1)
		log := &statementLog{}
		db := hookedDB(t, log, ddl+typedMetricRows)
		// A newly eligible multi-field count batch must not retry opaque source
		// functions even when a value fails validation.
		d.SourceSQL = "SELECT *,qt_test_metric_probe(n) AS probed FROM events"
		field := d.Schema.Fields["n"]
		field.Expr = "r.probed"
		d.Schema.Fields["n"] = field
		if sidecar {
			field = d.Schema.Fields["m"]
			field.ValueErrorExpr = "CASE WHEN r.id='1' THEN 'text_range' WHEN r.id='2' THEN 'storage_type' END"
			d.Schema.Fields["m"] = field
		}
		q.Metrics = []qt.AggSpec{{ID: "sum", Op: "sum", Field: "n"}, {ID: "count", Op: "count", Field: "m"}}
		log.reset(nil)
		metricProbeCalls.Store(0)
		got, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
		if err != nil {
			t.Fatal(err)
		}
		calls := metricProbeCalls.Load()
		log.reset(declineDirect)
		metricProbeCalls.Store(0)
		want, err := d.Execute(context.Background(), db, q, qt.PlanOptions{})
		if err != nil || !reflect.DeepEqual(got, want) || calls == 0 || metricProbeCalls.Load() != calls {
			t.Fatalf("got %#v want %#v calls=%d/%d err=%v", got, want, calls, metricProbeCalls.Load(), err)
		}
	}
}

func TestV3TextOnlyCountDeclinesOnce(t *testing.T) {
	for _, grouped := range []bool{false, true} {
		t.Run(map[bool]string{false: "metric", true: "grouping"}[grouped], func(t *testing.T) {
			ddl, d, q := typedMetricFixture(1)
			log := &statementLog{}
			db := hookedDB(t, log, ddl+typedMetricRows+"UPDATE events SET m=CAST(X'ff' AS TEXT) WHERE id='1'")
			q.Metrics[0].Expression = "COUNT_DISTINCT([m])"
			if grouped {
				q.Rows = true
				q.Grouping = &qt.GroupingDefinition{Keys: []string{"g1", "g2"}, Summaries: []qt.SummaryColumn{
					{ID: "distinct", Op: "count_distinct", Field: "m"},
					{ID: "values", Op: "count", Field: "m"},
				}}
				q.Result = qt.WireQuery{Select: []string{"g1", "g2", "distinct", "values"}, Limit: 200}
				q.Metrics = []qt.AggSpec{{ID: "groups", Op: "count"}}
			}
			log.reset(nil)
			got, gotErr := d.Execute(context.Background(), db, q, qt.PlanOptions{})
			// Both modes compile to one statement without a SUM/AVG leaf. A
			// declined attempt must not rescan the population with it again.
			attempts := map[string]int{}
			for _, statement := range log.seen {
				if strings.HasPrefix(statement, "CREATE TEMP TABLE") && strings.Contains(statement, "qt_integer_input") {
					attempts[statement]++
					if attempts[statement] > 1 {
						t.Fatalf("repeated declined reduction: %s", statement)
					}
				}
			}
			if len(attempts) != 1 {
				t.Fatalf("expected one native attempt, got %d", len(attempts))
			}
			log.reset(declineDirect)
			want, wantErr := d.Execute(context.Background(), db, q, qt.PlanOptions{})
			if !reflect.DeepEqual(got, want) || (gotErr == nil) != (wantErr == nil) || gotErr != nil && gotErr.Error() != wantErr.Error() {
				t.Fatalf("optimized %#v / %v\ngeneral %#v / %v", got, gotErr, want, wantErr)
			}
		})
	}
}
