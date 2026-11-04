package querytable

import (
	"context"
)

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
			return o, err
		}
	}
	if token != "" {
		if o.ValidatePlanToken == nil {
			return o, diagnostic(ErrorCodePlanTokenValidationRequired, "host must validate actor/dataset/profile/expiry-bound plan token")
		}
		if err := o.ValidatePlanToken(ctx, token); err != nil {
			return o, err
		}
	}
	if revisions != nil {
		o.ExpectedRevisions = revisions
	}
	return o, nil
}
