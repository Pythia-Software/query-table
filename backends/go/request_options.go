package querytable

import (
	"context"
	"errors"
)

// hostRejection codes a snapshot or plan-token validator's refusal. Its text
// is the host's and may describe infrastructure, so only a coded diagnostic
// keeps its own; any other refusal is execution_expired. The host's error
// stays in the chain for errors.Is.
func hostRejection(err error) error {
	var issue *PlanDiagnostic
	if errors.As(err, &issue) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return rejection{&PlanDiagnostic{Code: ErrorCodeExecutionExpired, Message: "the execution snapshot or plan token was rejected; refresh the execution handshake"}, err}
}

type rejection struct {
	issue *PlanDiagnostic
	cause error
}

func (r rejection) Error() string   { return r.issue.Error() }
func (r rejection) Unwrap() []error { return []error{r.issue, r.cause} }

func requestOptionsDialect(ctx context.Context, sqlite bool, profile, token, snapshot string, revisions map[string]string, o PlanOptions) (PlanOptions, error) {
	expected := ServerExpressionProfile
	if sqlite {
		expected = SQLiteExpressionProfile
	}
	if profile != "" && profile != expected {
		return o, diagnostic(ErrorCodeProfileMismatch, "requested execution profile is unavailable")
	}
	if snapshot != "" {
		if len(snapshot) > 10000 || o.ValidateSnapshot == nil {
			return o, diagnostic(ErrorCodeSnapshotValidationRequired, "host must validate and bind the requested data snapshot")
		}
		if err := o.ValidateSnapshot(ctx, snapshot); err != nil {
			return o, hostRejection(err)
		}
	}
	if token != "" {
		if o.ValidatePlanToken == nil {
			return o, diagnostic(ErrorCodePlanTokenValidationRequired, "host must validate actor/dataset/profile/expiry-bound plan token")
		}
		if err := o.ValidatePlanToken(ctx, token); err != nil {
			return o, hostRejection(err)
		}
	}
	if revisions != nil {
		o.ExpectedRevisions = revisions
	}
	return o, nil
}
