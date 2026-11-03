package sqlitetests

import (
	"fmt"
	"strings"
	"testing"

	qt "github.com/Pythia-Software/query-table/backends/go"
)

func TestRowsFloatNoiseMetricsParity(t *testing.T) {
	s := rowsSchema()
	rows := make([]map[string]any, 4000)
	for i := range rows {
		tokens := int64(1834 + i)
		rows[i] = map[string]any{
			"id": fmt.Sprint(i), "text": fmt.Sprintf("session-%d", i%700), "enum": fmt.Sprint(i % 10),
			"n": float64(tokens) * 0.30 / 1e6, "n2": tokens, "n3": tokens / 3, "n4": tokens / 2, "n5": tokens * 2,
		}
	}
	db := openRowsDB(t)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	stageMemoryRows(t, tx, s, rows)
	d := qt.QueryDatasetV3{Dialect: "sqlite", Schema: s, SourceSQL: "SELECT * FROM memory"}
	for _, groups := range [][]string{nil, {"enum"}} {
		q := metricsV3(nil, nil, 0, 0)
		for _, field := range []string{"n", "n2", "n3", "n4", "n5"} {
			q.Metrics = append(q.Metrics, qt.AggSpec{ID: field, Op: "sum", Field: field, GroupBy: groups})
		}
		q.Metrics = append(q.Metrics, qt.AggSpec{ID: "sessions", Op: "count_distinct", Field: "text", GroupBy: groups},
			qt.AggSpec{ID: "avg", Op: "avg", Field: "n", GroupBy: groups})
		compareStaged(t, tx, d, q, qt.PlanOptions{})
	}
}

func TestRowsGroupEncodingParity(t *testing.T) {
	s := rowsSchema()
	var rows []map[string]any
	for _, a := range []any{nil, "", "a", "ab", "bc", "c", "\x01\x02\x03", "\"\\\n", "é🙂", strings.Repeat("x", 130)} {
		for _, b := range []any{nil, "", "a", "ab", "bc", "c", "\x01\x02\x03", "true", "false"} {
			for _, flag := range []any{nil, false, true, int64(0), int64(1)} {
				rows = append(rows, map[string]any{"id": fmt.Sprint(len(rows)), "text": a, "enum": b, "flag": flag})
			}
		}
	}
	db := openRowsDB(t)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	stageMemoryRows(t, tx, s, rows)
	d := qt.QueryDatasetV3{Dialect: "sqlite", Schema: s, SourceSQL: "SELECT * FROM memory"}
	q := metricsV3(nil, nil, 0, 0, []qt.AggSpec{{ID: "groups", Op: "count", GroupBy: []string{"text", "enum", "flag"}}}...)
	compareStaged(t, tx, d, q, qt.PlanOptions{})
	q.Metrics[0].MinCount = qt.MetricMinCount{Min: 2}
	q.Metrics[0].GroupLimit = 13
	q.Metrics[0].Sort = []qt.MetricSort{{Key: "group0", Dir: "desc", Nulls: "first"}, {Key: "count", Dir: "asc"}}
	compareStaged(t, tx, d, q, qt.PlanOptions{})
	d.MaxGroups = 269
	compareStaged(t, tx, d, q, qt.PlanOptions{})
}

func TestRowsDecimalErrorPriorityParity(t *testing.T) {
	for name, values := range map[string][]any{
		"absolute bound":         {int64(1<<53 - 1), 1e-300},
		"underflow":              {1.0000000000000002e-300, -1e-300},
		"storage after overflow": {int64(1 << 52), int64(1 << 52), "bad"},
		"range after overflow":   {int64(1 << 52), int64(1 << 52), 1e101},
		"unsafe and storage":     {int64(1 << 53), "bad"},
		"range and storage":      {1e-301, "bad"},
	} {
		t.Run(name, func(t *testing.T) {
			s := rowsSchema()
			rows := make([]map[string]any, len(values))
			for i, v := range values {
				rows[i] = map[string]any{"id": fmt.Sprint(i), "n": v}
			}
			db := openRowsDB(t)
			tx, err := db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			stageMemoryRows(t, tx, s, rows)
			d := qt.QueryDatasetV3{Dialect: "sqlite", Schema: s, SourceSQL: "SELECT * FROM memory"}
			q := metricsV3(nil, nil, 0, 0, []qt.AggSpec{{ID: "sum", Op: "sum", Field: "n"}, {ID: "avg", Op: "avg", Field: "n"}}...)
			compareStaged(t, tx, d, q, qt.PlanOptions{})
			for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
				rows[i], rows[j] = rows[j], rows[i]
			}
			stageMemoryRows(t, tx, s, rows) // restage in the reversed order
			compareStaged(t, tx, d, q, qt.PlanOptions{})
		})
	}
}
