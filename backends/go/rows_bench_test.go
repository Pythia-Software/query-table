package querytable

import (
	"context"
	"fmt"
	"math"
	"testing"
)

// Keep the population and request construction outside the timed region. Costs
// deliberately retain the float noise introduced by token/price arithmetic.
func benchmarkRowsFixture() (SQLiteV2Dataset, []map[string]any) {
	s := Schema{Name: "usage", IDField: "id", Fields: map[string]FieldSpec{}}
	for _, name := range []string{"id", "week", "provider", "agent_session_id"} {
		s.Fields[name] = FieldSpec{Name: name, Kind: FieldText, Expr: "r." + name, Sortable: true}
	}
	for _, name := range []string{"input_tokens", "output_tokens", "cache_read_tokens", "total_tokens", "cost_usd"} {
		s.Fields[name] = FieldSpec{Name: name, Kind: FieldNumber, Expr: "r." + name, ExpressionNumeric: true}
	}
	rows := make([]map[string]any, 20000)
	for i := range rows {
		tokens := int64(1834 + i%10000)
		rows[i] = map[string]any{
			"id": fmt.Sprint(i), "week": fmt.Sprintf("2026-W%02d", 1+i%52),
			"provider": fmt.Sprintf("provider-%d", i%10), "agent_session_id": fmt.Sprintf("session-%d", i%7000),
			"input_tokens": tokens, "output_tokens": tokens / 3, "cache_read_tokens": tokens / 2,
			"total_tokens": tokens * 2, "cost_usd": float64(tokens) * 0.30 / 1e6,
		}
	}
	return SQLiteV2Dataset{Schema: s}, rows
}

func benchmarkExecuteRows(b *testing.B, d SQLiteV2Dataset, rows []map[string]any, metrics []AggSpec) {
	b.Helper()
	q := MetricQuery{Version: 2, Metrics: metrics}
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		result, err := ExecuteV2Rows(context.Background(), nil, d, rows, q, PlanOptions{})
		if err != nil {
			b.Fatal(err)
		}
		for _, m := range result.Metrics.Metrics {
			if m.Error != "" {
				b.Fatal(m.Error)
			}
			for _, bucket := range m.Buckets {
				if bucket.Error != "" {
					b.Fatal(bucket.Error)
				}
			}
		}
	}
}

func BenchmarkV2RowsGroupedCount(b *testing.B) {
	d, rows := benchmarkRowsFixture()
	benchmarkExecuteRows(b, d, rows, []AggSpec{{ID: "count", Op: "count", GroupBy: []string{"week", "provider"}}})
}

func BenchmarkV2RowsDecimalSum(b *testing.B) {
	for _, rounded := range []bool{false, true} {
		name := "float_noise"
		if rounded {
			name = "six_places"
		}
		b.Run(name, func(b *testing.B) {
			d, rows := benchmarkRowsFixture()
			if rounded {
				for _, row := range rows {
					row["cost_usd"] = math.Round(row["cost_usd"].(float64)*1e6) / 1e6
				}
			}
			benchmarkExecuteRows(b, d, rows, []AggSpec{{ID: "cost", Op: "sum", Field: "cost_usd"}})
		})
	}
}

func BenchmarkV2RowsTokenSummary(b *testing.B) {
	d, rows := benchmarkRowsFixture()
	metrics := []AggSpec{}
	for _, name := range []string{"input_tokens", "output_tokens", "cache_read_tokens", "total_tokens", "cost_usd"} {
		metrics = append(metrics, AggSpec{ID: name, Op: "sum", Field: name})
	}
	metrics = append(metrics, AggSpec{ID: "sessions", Op: "count_distinct", Field: "agent_session_id"})
	benchmarkExecuteRows(b, d, rows, metrics)
}
