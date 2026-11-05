package querytable

// The result wire types (QueryResultV3, MetricResult, ComputedExecution, ...)
// are generated in wire_generated.go from schema/query-wire.schema.json.

// ComputedDescription keeps the editable catalogue separate from the valid
// execution envelope. Only successfully compiled transitive graphs advertise
// capabilities/revisions; infrastructure and context errors fail the request.
type ComputedDescription struct {
	Execution   ComputedExecution          `json:"execution"`
	Diagnostics map[string]*PlanDiagnostic `json:"diagnostics"`
}
