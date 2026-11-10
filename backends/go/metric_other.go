package querytable

import (
	"fmt"
	"math"
	"strings"
)

// The Other remainder (MetricResult.Other), mirroring metricOtherRemainder in
// packages/core/src/metrics.ts: the exact remainder of the groups GroupLimit
// omits, after MinCount, so hidden groups are never part of it.
//
//   - A single SUM or COUNT: the sum of the omitted values (a SUM group with
//     no values adds nothing), when no omitted group has an error.
//   - A ratio of SUM or COUNT parts (metricRatio.additive): each part pooled
//     over the omitted groups and the ratio evaluated on the pooled parts,
//     when no part has an error. An empty calendar fill-in adds 0 to each
//     part. With an interval, the remainder has bounds from the pooled parts.
//
// Distinct counts, averages, extrema, medians, distributions and scatters do
// not add across groups and have no remainder. Compiled plans pool the
// omitted groups with window aggregates (metricResult); calendar metrics,
// which rank and limit in Go, pool their buckets here.

// otherShape is the Other remainder a metric can have: plain names a single
// SUM or COUNT, ratio an additive ratio; neither when it has none.
type otherShape struct {
	plain string
	ratio *metricRatio
}

func metricOtherShape(spec AggSpec) otherShape {
	n, err := parseExpression(metricExpression(spec))
	if err != nil {
		return otherShape{}
	}
	return metricOtherShapeOf(spec, n)
}

func metricOtherShapeOf(spec AggSpec, n *exprNode) otherShape {
	if spec.Distribution != nil || spec.ExpressionY != "" || (spec.Display != nil && spec.Display.Kind == "scatter") {
		return otherShape{}
	}
	if op := strings.ToUpper(n.op); (op == "SUM" || op == "COUNT") && len(n.args) <= 1 {
		return otherShape{plain: op}
	}
	if r, err := metricRatioParts(n); err == nil && r.additive() {
		return otherShape{ratio: &r}
	}
	return otherShape{}
}

// columns are the result columns the remainder pools.
func (s otherShape) columns() []ValueSQL {
	switch {
	case s.plain != "":
		return []ValueSQL{{Value: "value", Error: "error"}}
	case s.ratio != nil:
		return []ValueSQL{{Value: "ratio_numerator", Error: "ratio_numerator_error"}, {Value: "ratio_denominator", Error: "ratio_denominator_error"}}
	}
	return nil
}

// otherSums pools the omitted groups: their number, rows and errors, and for
// each pooled column its sum, non-NULL values and errors.
type otherSums struct {
	groups, count, errors int64
	sums                  []float64
	seen, partErrors      []int64
}

func otherSumsFromRow(v map[string]any, parts int) otherSums {
	number := func(key string) float64 {
		n, _ := intervalNumber(v[key])
		return n
	}
	s := otherSums{groups: int64(number("other_groups")), count: int64(number("other_count")), errors: int64(number("other_errors"))}
	for i := 0; i < parts; i++ {
		p := fmt.Sprintf("other_p%d", i)
		s.sums = append(s.sums, number(p))
		s.seen = append(s.seen, int64(number(p+"_n")))
		s.partErrors = append(s.partErrors, int64(number(p+"_errors")))
	}
	return s
}

func otherSumsFromBuckets(omitted []MetricBucket, parts int) otherSums {
	s := otherSums{sums: make([]float64, parts), seen: make([]int64, parts), partErrors: make([]int64, parts)}
	add := func(i int, v any, failed bool) {
		if failed {
			s.partErrors[i]++
			return
		}
		if v == nil {
			return
		}
		n, ok := intervalNumber(v)
		if !ok {
			s.partErrors[i]++
			return
		}
		s.sums[i] += n
		s.seen[i]++
	}
	for _, b := range omitted {
		s.groups++
		s.count += b.Count
		if b.Error != "" {
			s.errors++
		}
		switch {
		case parts == 1:
			add(0, b.Value, b.Error != "")
		case parts == 2 && b.Count == 0 && b.ratioParts[0] == nil && b.ratioParts[1] == nil:
			// An empty calendar fill-in.
			add(0, 0.0, false)
			add(1, 0.0, false)
		case parts == 2:
			add(0, b.ratioParts[0], b.ratioPartError)
			add(1, b.ratioParts[1], b.ratioPartError)
		}
	}
	return s
}

// remainder is the Other bucket of the pooled groups, or nil when there is
// none.
func (s otherShape) remainder(spec AggSpec, sums otherSums) *MetricBucket {
	if sums.groups == 0 || len(sums.sums) != len(s.columns()) || len(sums.sums) == 0 {
		return nil
	}
	exact := func(v float64) bool {
		return !math.IsNaN(v) && !math.IsInf(v, 0) && (v != math.Trunc(v) || math.Abs(v) <= 9007199254740991)
	}
	if s.plain != "" {
		if sums.errors > 0 || sums.partErrors[0] > 0 || !exact(sums.sums[0]) {
			return nil
		}
		return &MetricBucket{Keys: []any{}, Value: sums.sums[0], Count: sums.count}
	}
	var parts [2]*float64
	names := [2]*exprNode{s.ratio.numerator, s.ratio.denominator}
	for i := range parts {
		if sums.partErrors[i] > 0 || !exact(sums.sums[i]) {
			return nil
		}
		// COUNT is never NULL; a SUM without values is.
		if sums.seen[i] > 0 || strings.ToUpper(names[i].op) == "COUNT" {
			v := sums.sums[i]
			parts[i] = &v
		}
	}
	b := &MetricBucket{Keys: []any{}, Count: sums.count}
	b.Value, b.Error = s.ratio.value(parts[0], parts[1])
	if spec.Interval != nil && b.Error == "" && b.Value != nil {
		lower, upper, ok, domain := metricIntervalBounds(spec.Interval, *parts[0], *parts[1], s.ratio.scale)
		switch {
		case domain:
			b.IntervalError = metricIntervalDomain
		case ok:
			b.Lower, b.Upper = &lower, &upper
		}
	}
	return b
}
