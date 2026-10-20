package querytable

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

// inlineSchema binds x and g either to host SQL or to executor-staged columns.
func inlineSchema(staged bool) Schema {
	s := metricSchema()
	for name, f := range s.Fields {
		f.typedValue = staged
		s.Fields[name] = f
	}
	return s
}

// checkInlining asserts the SQLite inlining invariants over a builder: an
// unmaterialized projection never reads a host binding before some stage has
// stored it, and one reference never expands past maxInlineReads.
func checkInlining(t *testing.T, b *planBuilder) (inlined int) {
	t.Helper()
	for name, alias := range b.aliases {
		if alias.stage == 0 || b.stages[alias.stage].Materialized {
			continue
		}
		inlined++
		if alias.reads < 1 || alias.reads > maxInlineReads {
			t.Errorf("%s at stage %d expands to %d reads", name, alias.stage, alias.reads)
		}
		for _, ref := range rowAliasPattern.FindAllString(b.stages[alias.stage].SQL, -1) {
			if !strings.HasPrefix(ref, "f") || b.aliases[ref].reads > 0 {
				continue
			}
			stored := false
			for _, stage := range b.stages[:alias.stage] {
				stored = stored || stage.Materialized
			}
			if !stored {
				t.Errorf("stage %d inlines host binding %s: %s", alias.stage, ref, b.stages[alias.stage].SQL)
			}
		}
	}
	return inlined
}

func TestSQLiteInlineProjectionsRespectHostBindings(t *testing.T) {
	ctx := context.Background()
	o := metricOptions()
	o.SourceSQL = "SELECT * FROM fixture"
	nested := "[x]"
	for i := 0; i < 12; i++ {
		nested = fmt.Sprintf("COALESCE(IF([x]>%d,%s,NULL),[y])", i, nested)
	}
	for _, staged := range []bool{false, true} {
		for _, source := range []string{"[x]", "IF([x]>1,[x],[y])", "IF([x]>1 AND [g]=\"a\",[x],NULL)", nested} {
			b, err := newPlanDialect(ctx, inlineSchema(staged), o, true)
			if err != nil {
				t.Fatal(err)
			}
			n, err := parseExpression(source)
			if err != nil {
				t.Fatal(err)
			}
			v, err := b.row(n)
			if err != nil {
				t.Fatal(err)
			}
			b.metricNumber(v)
			if inlined := checkInlining(t, b); inlined == 0 {
				t.Errorf("staged=%v %.40s: no projection was inlined", staged, source)
			}
			// The guarded numeric input of a staged field is read directly.
			if staged && source == "[x]" {
				for i, stage := range b.stages[1:] {
					if stage.Materialized {
						t.Errorf("staged numeric guard materialized stage %d: %s", i+1, stage.SQL)
					}
				}
			}
		}
	}
}
