package querytable

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// MetricMinCount is AggSpec.MinCount, mirroring AggregationClause.minCount.
// Min alone counts each group's rows; on the wire it is a plain number. With
// Distinct it counts the field's distinct non-null values, and with Sum it
// sums a numeric field (null adds nothing); on the wire these are
// {"min":5,"distinct":"conversation_id"} and {"min":10,"sum":"call_count"}.
// The measure has the semantics of COUNT_DISTINCT([field]) or SUM([field]) in a
// metric expression. A group whose measure is an error is kept, so the error
// stays visible. The zero value means no minimum.
type MetricMinCount struct {
	Min      int
	Distinct string
	Sum      string
}

// Active reports whether a minimum is set.
func (m MetricMinCount) Active() bool { return m.Min > 0 }

// Measure is the aggregate expression a Distinct or Sum minimum compares with
// Min, such as COUNT_DISTINCT([conversation_id]); "" when it counts rows.
func (m MetricMinCount) Measure() string {
	switch {
	case m.Distinct != "":
		return MetricExpression(AggSpec{Op: "count_distinct", Field: m.Distinct})
	case m.Sum != "":
		return MetricExpression(AggSpec{Op: "sum", Field: m.Sum})
	}
	return ""
}

// MarshalJSON writes a row minimum as a number and a measured one as an object.
func (m MetricMinCount) MarshalJSON() ([]byte, error) {
	if m.Distinct == "" && m.Sum == "" {
		return json.Marshal(m.Min)
	}
	type object struct {
		Min      int    `json:"min"`
		Distinct string `json:"distinct,omitempty"`
		Sum      string `json:"sum,omitempty"`
	}
	return json.Marshal(object(m))
}

// UnmarshalJSON reads a number or an object with min and exactly one of
// distinct and sum. Unknown object members are rejected.
func (m *MetricMinCount) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if bytes.Equal(trimmed, []byte("null")) {
		*m = MetricMinCount{}
		return nil
	}
	if len(trimmed) == 0 || trimmed[0] != '{' {
		var n float64
		if err := json.Unmarshal(trimmed, &n); err != nil {
			return fmt.Errorf("minCount must be a number or an object")
		}
		if n != math.Trunc(n) || math.Abs(n) > float64(MaxMetricMinCount)+1 {
			return fmt.Errorf("minCount must be an integer between 1 and %d", MaxMetricMinCount)
		}
		*m = MetricMinCount{Min: int(n)}
		return nil
	}
	var object struct {
		Min      *float64 `json:"min"`
		Distinct *string  `json:"distinct"`
		Sum      *string  `json:"sum"`
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&object); err != nil {
		return fmt.Errorf("invalid minCount object: %w", err)
	}
	if object.Min == nil || *object.Min != math.Trunc(*object.Min) || math.Abs(*object.Min) > float64(MaxMetricMinCount)+1 {
		return fmt.Errorf("minCount min must be an integer between 1 and %d", MaxMetricMinCount)
	}
	if (object.Distinct == nil) == (object.Sum == nil) {
		return fmt.Errorf("minCount object needs exactly one of distinct and sum")
	}
	*m = MetricMinCount{Min: int(*object.Min)}
	if object.Distinct != nil {
		m.Distinct = *object.Distinct
		if m.Distinct == "" {
			return fmt.Errorf("minCount distinct needs a field")
		}
	} else {
		m.Sum = *object.Sum
		if m.Sum == "" {
			return fmt.Errorf("minCount sum needs a field")
		}
	}
	return nil
}

// validate applies the request limits shared with the TypeScript validator.
func (m MetricMinCount) validate(id string) error {
	if m.Min < 0 || m.Min > MaxMetricMinCount || (m.Min == 0 && (m.Distinct != "" || m.Sum != "")) {
		return fmt.Errorf("aggregation %q minCount must be between 1 and %d", id, MaxMetricMinCount)
	}
	if m.Distinct != "" && m.Sum != "" {
		return fmt.Errorf("aggregation %q minCount needs exactly one of distinct and sum", id)
	}
	if len(m.Distinct) > maxFieldNameLength || len(m.Sum) > maxFieldNameLength {
		return fmt.Errorf("invalid minCount field name")
	}
	return nil
}

// field is the field a measured minimum reads, or "".
func (m MetricMinCount) field() string {
	if m.Distinct != "" {
		return m.Distinct
	}
	return m.Sum
}

// validateMinCountMeasure checks the field of a Distinct or Sum minimum. Its
// aggregate policy and input type are checked when the measure is compiled.
func validateMinCountMeasure(spec AggSpec, s Schema) error {
	name := spec.MinCount.field()
	if name == "" {
		return nil
	}
	f, ok := s.Fields[name]
	if !ok || strings.HasPrefix(name, "@computed/") {
		return diagnostic("min_count_field", "minCount must measure a schema field")
	}
	if spec.MinCount.Sum != "" && f.Kind != FieldNumber {
		return diagnostic("type_error", "a summed minCount requires a numeric field")
	}
	if spec.Distribution != nil {
		return diagnostic("min_count_distribution", "a distinct or summed minCount supports scalar metrics, not distributions")
	}
	return nil
}

// keeps reports whether a group with count rows survives the minimum, given
// its measure for a Distinct or Sum minimum. Groups without rows (calendar
// fill-ins) always do; a measure that is an error keeps its group.
func (m MetricMinCount) keeps(count int64, measure any, measureError bool) bool {
	if !m.Active() || count == 0 {
		return true
	}
	if m.Measure() == "" {
		return count >= int64(m.Min)
	}
	if measureError {
		return true
	}
	return minCountNumber(measure) >= float64(m.Min)
}

// minCountNumber reads a driver's numeric measure; NULL is 0.
func minCountNumber(v any) float64 {
	switch x := v.(type) {
	case int64:
		return float64(x)
	case float64:
		return x
	case []byte:
		n, _ := strconv.ParseFloat(string(x), 64)
		return n
	case string:
		n, _ := strconv.ParseFloat(x, 64)
		return n
	}
	return 0
}
