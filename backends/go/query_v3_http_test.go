package querytable

import (
	"strings"
	"testing"
)

// Stages accept exactly select, where, orderBy, limit and offset.
func TestDecodeQueryRequestV3StageProperties(t *testing.T) {
	request := func(stage string) []byte {
		return []byte(`{"version":3,"profile":"qt-sqlite-v1","now":0,"source":` + stage + `,"result":{"limit":1},"rows":true,"metrics":[]}`)
	}
	q, err := DecodeQueryRequestV3(request(`{"select":["id"],"where":[],"orderBy":[{"field":"id","dir":"asc"}],"limit":2,"offset":1}`))
	if err != nil || q.Source.Limit != 2 || q.Source.Offset != 1 || len(q.Source.OrderBy) != 1 || q.Source.Select[0] != "id" {
		t.Fatal(q, err)
	}
	for _, stage := range []string{`{"s":["id"]}`, `{"c":["id"]}`, `{"w":[]}`, `{"o":[]}`, `{"l":1}`, `{"f":0}`, `{"g":[]}`, `{"aggregations":[]}`, `{"hostState":{}}`, `{"orderBy":{"field":"id","dir":"asc"}}`} {
		_, err := DecodeQueryRequestV3(request(stage))
		if err == nil {
			t.Errorf("accepted stage %s", stage)
			continue
		}
		// The single-object orderBy fails type decoding instead.
		if !strings.HasPrefix(stage, `{"orderBy"`) && !strings.Contains(err.Error(), "unknown field") {
			t.Errorf("stage %s: %v", stage, err)
		}
	}
}
