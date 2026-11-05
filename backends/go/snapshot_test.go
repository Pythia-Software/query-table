package querytable

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func snapshotDataset() QueryDatasetV3 {
	return QueryDatasetV3{Schema: metricSchema(), SourceSQL: metricOptions().SourceSQL, Dialect: "postgres"}
}

const (
	snapshotRowsJSON    = `{"version":3,"profile":"qt-postgres-v1","now":0,"snapshot":"snapshot-2","source":{"select":["id"],"limit":2},"result":{"select":["id"],"where":[],"orderBy":[],"limit":2,"offset":0},"rows":true,"metrics":[]}`
	snapshotMetricsJSON = `{"version":3,"profile":"qt-postgres-v1","now":0,"snapshot":"snapshot-2","source":{"limit":1},"result":{"limit":1},"rows":false,"metrics":[{"id":"count","op":"count","groupBy":[]}]}`
)

func TestSnapshotBindingRequired(t *testing.T) {
	ctx := context.Background()
	d := snapshotDataset()
	options := metricOptions()
	var rows, metrics QueryRequestV3
	if err := json.Unmarshal([]byte(snapshotRowsJSON), &rows); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(snapshotMetricsJSON), &metrics); err != nil {
		t.Fatal(err)
	}
	if rows.Snapshot != "snapshot-2" {
		t.Fatal(rows)
	}
	if _, err := d.SourcePlan(ctx, rows, options); err == nil {
		t.Fatal("missing snapshot validation accepted")
	}
	if _, err := d.SourcePlan(ctx, metrics, options); err == nil {
		t.Fatal("metric snapshot ignored")
	}
	expected := errors.New("snapshot expired")
	options.ValidateSnapshot = func(_ context.Context, snapshot string) error {
		if snapshot != "snapshot-2" {
			t.Fatal(snapshot)
		}
		return expected
	}
	// The host's refusal stays in the chain, and clients see execution_expired.
	if _, err := d.SourcePlan(ctx, rows, options); !errors.Is(err, expected) || ErrorDetail(err).Code != ErrorCodeExecutionExpired || ErrorDetail(err).Message == "snapshot expired" {
		t.Fatal(err)
	}
	if _, err := d.SourcePlan(ctx, metrics, options); !errors.Is(err, expected) {
		t.Fatal(err)
	}
	options.ValidateSnapshot = func(_ context.Context, snapshot string) error { return nil }
	if _, err := d.SourcePlan(ctx, rows, options); err != nil {
		t.Fatal(err)
	}
	if _, err := d.SourcePlan(ctx, metrics, options); err != nil {
		t.Fatal(err)
	}
}

func TestSnapshotEnvelopeAndCallback(t *testing.T) {
	// Reusing a decoded request must clear old snapshot metadata when omitted.
	d := snapshotDataset()
	var rows, metrics QueryRequestV3
	if err := json.Unmarshal([]byte(snapshotRowsJSON), &rows); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(snapshotMetricsJSON), &metrics); err != nil {
		t.Fatal(err)
	}
	if metrics.Snapshot != "snapshot-2" {
		t.Fatal(metrics)
	}
	type contextKey struct{}
	ctx := context.WithValue(context.Background(), contextKey{}, "request")
	calls := 0
	o := metricOptions()
	o.ValidateSnapshot = func(got context.Context, snapshot string) error {
		calls++
		if got != ctx || got.Value(contextKey{}) != "request" || snapshot != "snapshot-2" {
			t.Fatal("lost callback context/token", snapshot)
		}
		return nil
	}
	p, err := d.SourcePlan(ctx, rows, o)
	if err != nil || !p.RequiresSnapshot {
		t.Fatal(p, err)
	}
	batch, err := d.SourcePlan(ctx, metrics, o)
	if err != nil || !batch.RequiresSnapshot {
		t.Fatal(batch, err)
	}
	if calls != 2 {
		t.Fatal("expected one validation per request", calls)
	}
	rows.Snapshot, metrics.Snapshot = strings.Repeat("s", 10001), strings.Repeat("s", 10001)
	for _, request := range []QueryRequestV3{rows, metrics} {
		var diagnostic *PlanDiagnostic
		if _, err := d.SourcePlan(ctx, request, o); !errors.As(err, &diagnostic) || diagnostic.Code != "snapshot_validation_required" {
			t.Fatal(err)
		}
	}
	if calls != 2 {
		t.Fatal("oversized snapshot reached host", calls)
	}
	// DecodeQueryRequestV3 always decodes into a fresh request.
	rows, err = DecodeQueryRequestV3([]byte(strings.Replace(snapshotRowsJSON, `"snapshot":"snapshot-2",`, "", 1)))
	if err != nil {
		t.Fatal(err)
	}
	if rows.Snapshot != "" {
		t.Fatal("stale row snapshot", rows.Snapshot)
	}
	metrics.Snapshot = ""
	if _, err := d.SourcePlan(ctx, rows, o); err != nil {
		t.Fatal(err)
	}
	if _, err := d.SourcePlan(ctx, metrics, o); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatal("empty snapshot reached host", calls)
	}
}
