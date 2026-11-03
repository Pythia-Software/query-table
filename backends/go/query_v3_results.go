package querytable

// Result types of QueryResultV3 and the computed-field handshake. They are
// the same for SQLite and PostgreSQL.

// ComputedFieldCapability is what a canonical computed field may do in a view.
type ComputedFieldCapability struct {
	Filter  bool   `json:"filter,omitempty"`
	Type    string `json:"type"`
	Select  bool   `json:"select"`
	Sort    bool   `json:"sort"`
	Measure bool   `json:"measure"`
	Group   bool   `json:"group"`
}

// ComputedExecution is the computed-field envelope of a result: its profile,
// token, snapshot, the revisions it resolved and each field's capability.
// A fingerprint is not authorization. Hosts may attach a signed planToken and
// a snapshot only when they actually bind subsequent requests to that snapshot.
type ComputedExecution struct {
	Profile           string                             `json:"profile"`
	PlanToken         string                             `json:"planToken"`
	ResolvedRevisions map[string]string                  `json:"resolvedRevisions"`
	Fields            map[string]ComputedFieldCapability `json:"fields"`
	Fingerprint       string                             `json:"fingerprint,omitempty"`
	Snapshot          string                             `json:"snapshot,omitempty"`
}

// MetricBucket is one group of a MetricResult; Keys follow AggSpec.GroupBy.
type MetricBucket struct {
	Distribution    MetricDistributionResult `json:"distribution,omitempty"`
	NullCount       *int64                   `json:"nullCount,omitempty"`
	InputErrorCount *int64                   `json:"inputErrorCount,omitempty"`
	Keys            []any                    `json:"keys"`
	Value           any                      `json:"value"`
	Count           int64                    `json:"count"`
	Error           string                   `json:"error,omitempty"`
	Y               *any                     `json:"y,omitempty"`
	YError          string                   `json:"yError,omitempty"`
	// A measured minCount's value for calendar filtering; never serialized.
	minMeasure      any
	minMeasureError bool
}

// MetricResult is one AggSpec's result, in QueryResultV3.Metrics order.
type MetricResult struct {
	ID            string         `json:"id"`
	Buckets       []MetricBucket `json:"buckets"`
	Scope         string         `json:"scope"`
	ProcessedRows int64          `json:"processedRows"`
	GroupCount    int64          `json:"groupCount"`
	Coverage      string         `json:"coverage,omitempty"`
	// Error reports a metric that could not be computed. Sibling metrics and
	// rows in the same request are unaffected.
	Error string `json:"error,omitempty"`
	// HiddenGroups counts groups removed by AggSpec.MinCount; nil when unset.
	HiddenGroups *int64 `json:"hiddenGroups,omitempty"`
}

// ComputedDescription keeps the editable catalogue separate from the valid
// execution envelope. Only successfully compiled transitive graphs advertise
// capabilities/revisions; infrastructure and context errors fail the request.
type ComputedDescription struct {
	Execution   ComputedExecution          `json:"execution"`
	Diagnostics map[string]*PlanDiagnostic `json:"diagnostics"`
}
