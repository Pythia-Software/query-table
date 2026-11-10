package querytable

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Request-level diagnostics describe the request, handshake, view or host
// configuration rather than one metric clause. They still fail the batch.
var requestDiagnostics = map[ErrorCode]bool{
	ErrorCodeVersion: true, ErrorCodeInvalidQuery: true, ErrorCodeResidualQuery: true, ErrorCodeProfileMismatch: true,
	ErrorCodeScope: true, ErrorCodeDuplicateMetric: true, ErrorCodeFilter: true, ErrorCodeSort: true, ErrorCodeWindowRequired: true,
	ErrorCodeDefinitionChanged: true, ErrorCodeResolverRequired: true, ErrorCodeResolverScope: true, ErrorCodeDataset: true,
	ErrorCodeSnapshotTransactionRequired: true, ErrorCodeSnapshotValidationRequired: true, ErrorCodePlanTokenValidationRequired: true,
	ErrorCodeSourceRequired: true, ErrorCodeSchema: true, ErrorCodeSchemaLimit: true, ErrorCodeIdentityRequired: true, ErrorCodeDuplicateIdentity: true,
}

// metricClauseError reports whether err belongs to one metric clause, and the
// code and message to return for it. Cancellation and request-level
// diagnostics fail the request. Statement failures (for example a host
// statement timeout) are isolated as internal errors and not exposed
// verbatim, matching the v3 HTTP handler.
func metricClauseError(ctx context.Context, err error) (ErrorCode, string, bool) {
	if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return "", "", false
	}
	var relationErr *sqliteRelationError
	if errors.As(err, &relationErr) {
		return "", "", false // a host predicate relation failed, not this clause
	}
	var issue *PlanDiagnostic
	if errors.As(err, &issue) {
		if requestDiagnostics[issue.Code] {
			return "", "", false
		}
		return issue.Code, issue.Message, true
	}
	return ErrorCodeInternal, "could not execute metric", true
}

func failedMetric(id, scope string, code ErrorCode, message string) MetricResult {
	if scope == "" {
		scope = "allMatching"
	}
	return MetricResult{ID: id, Scope: scope, Buckets: []MetricBucket{}, Error: message, ErrorCode: code}
}

// isolateMetric runs one metric inside a savepoint so a failed PostgreSQL
// statement does not abort the transaction for later metrics or the commit.
// Clause failures become that metric's error. Cancellation, request-level
// diagnostics and a savepoint that cannot be restored fail the request.
func isolateMetric(ctx context.Context, tx *sql.Tx, id, scope string, run func() (MetricResult, error)) (MetricResult, error) {
	if _, err := tx.ExecContext(ctx, "SAVEPOINT qt_metric"); err != nil {
		return MetricResult{}, err
	}
	metric, err := run()
	if err == nil {
		if _, err = tx.ExecContext(ctx, "RELEASE SAVEPOINT qt_metric"); err != nil {
			return MetricResult{}, err
		}
		return metric, nil
	}
	code, message, clause := metricClauseError(ctx, err)
	if !clause {
		return MetricResult{}, err
	}
	if _, rollback := tx.ExecContext(ctx, "ROLLBACK TO SAVEPOINT qt_metric"); rollback != nil {
		return MetricResult{}, errors.Join(err, rollback)
	}
	if _, release := tx.ExecContext(ctx, "RELEASE SAVEPOINT qt_metric"); release != nil {
		return MetricResult{}, errors.Join(err, release)
	}
	return failedMetric(id, scope, code, message), nil
}

// callsOp reports whether the expression calls the lower-case function op.
func callsOp(n *exprNode, op string) bool {
	if strings.EqualFold(n.op, op) {
		return true
	}
	for _, a := range n.args {
		if callsOp(a, op) {
			return true
		}
	}
	return false
}

// sampleBudgetMessage names the sampled reduction and the host budget.
func sampleBudgetMessage(spec AggSpec, limit int) string {
	what := "MEDIAN"
	if n, err := parseExpression(metricExpression(spec)); err == nil && !callsOp(n, "median") {
		what = "PERCENTILE"
	}
	if spec.Distribution != nil {
		what = "The " + spec.Distribution.Kind + " distribution"
	}
	message := fmt.Sprintf("%s exceeded the %s-sample budget", what, groupedThousands(limit))
	if len(spec.GroupBy) > 0 {
		message += " for one or more groups"
	}
	return message
}

func groupedThousands(n int) string {
	s := strconv.Itoa(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}
