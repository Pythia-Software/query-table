package querytable

// schema.go — the backend projection of the JSON schema document. A FieldSpec
// is the SQL binding for one field; Schema is the per-dataset allowlist that
// Compile validates against. Built by LoadSchema from the same JSON document the
// frontend loads, so the two ends cannot drift.

import (
	"encoding/json"
	"fmt"
)

// FieldKind picks the value-coercion + operator-validation path.
type FieldKind int

const (
	FieldText FieldKind = iota
	FieldNumber
	FieldDatetime
	FieldBool
	FieldEnum
	FieldTextArray
)

func kindFromString(s string) (FieldKind, error) {
	switch s {
	case "text":
		return FieldText, nil
	case "number":
		return FieldNumber, nil
	case "datetime":
		return FieldDatetime, nil
	case "bool":
		return FieldBool, nil
	case "enum":
		return FieldEnum, nil
	case "textarray":
		return FieldTextArray, nil
	default:
		return FieldText, fmt.Errorf("unknown field type %q", s)
	}
}

// FieldSpec is one field's server binding. Expr is the server-defined SQL
// expression (from the document's bindings.postgres.expr) and is the injection
// boundary: it is never built from request input.
type FieldSpec struct {
	Name         string
	Kind         FieldKind
	Expr         string
	Synthetic    bool
	ServerFilter bool   // false → field is client-only; Compile rejects filters on it
	Sortable     bool
	SortExpr     string // expr to ORDER BY when it differs from Expr (FieldDef.sort.field → that field's Expr)
}

// Schema is the compiled, server-side field allowlist for one dataset.
type Schema struct {
	Name         string
	IDField      string
	Fields       map[string]FieldSpec
	DefaultSort  []OrderBy
	TiebreakSort []OrderBy
}

// ---- JSON document shapes (subset we read on the backend) -----------------

type docSQLBinding struct {
	Expr      string `json:"expr"`
	Synthetic bool   `json:"synthetic"`
	Kind      string `json:"kind"`
}

type docField struct {
	Name   string `json:"name"`
	Label  string `json:"label"`
	Type   string `json:"type"`
	Source any    `json:"source"` // "backend"|"derived" | object | absent
	Filter *struct {
		Enabled  *bool `json:"enabled"`
		Pushdown *bool `json:"pushdown"`
	} `json:"filter"`
	Sort *struct {
		Enabled *bool  `json:"enabled"`
		Field   string `json:"field"`
	} `json:"sort"`
	Bindings *struct {
		Postgres *docSQLBinding `json:"postgres"`
	} `json:"bindings"`
}

type schemaDoc struct {
	Name         string     `json:"name"`
	IDField      string     `json:"idField"`
	DefaultSort  []OrderBy  `json:"defaultSort"`
	TiebreakSort []OrderBy  `json:"tiebreakSort"`
	Fields       []docField `json:"fields"`
}

// LoadSchema parses + validates a JSON schema document (the bytes of a
// schema/*.schema.json file) into a Schema, reading the `postgres` binding for
// each backend field. Fields without a postgres binding (derived / render-only)
// are skipped — they're never filtered, sorted, or selected on the server.
func LoadSchema(doc []byte) (Schema, error) {
	var d schemaDoc
	if err := json.Unmarshal(doc, &d); err != nil {
		return Schema{}, fmt.Errorf("schema json: %w", err)
	}
	if d.Name == "" {
		return Schema{}, fmt.Errorf("schema: missing name")
	}
	if d.IDField == "" {
		return Schema{}, fmt.Errorf("schema: missing idField")
	}

	s := Schema{
		Name:         d.Name,
		IDField:      d.IDField,
		Fields:       make(map[string]FieldSpec, len(d.Fields)),
		DefaultSort:  d.DefaultSort,
		TiebreakSort: d.TiebreakSort,
	}

	// First pass: collect Expr per field so sort.field can reference another
	// field's expression.
	exprByName := map[string]string{}
	for _, f := range d.Fields {
		if f.Bindings != nil && f.Bindings.Postgres != nil {
			exprByName[f.Name] = f.Bindings.Postgres.Expr
		}
	}

	for _, f := range d.Fields {
		if f.Bindings == nil || f.Bindings.Postgres == nil {
			continue // derived / client-only field
		}
		pg := f.Bindings.Postgres
		if pg.Expr == "" {
			return Schema{}, fmt.Errorf("field %q: empty postgres expr", f.Name)
		}

		kindStr := pg.Kind
		if kindStr == "" {
			kindStr = f.Type
		}
		kind, err := kindFromString(kindStr)
		if err != nil {
			return Schema{}, fmt.Errorf("field %q: %w", f.Name, err)
		}

		serverFilter := true
		if f.Filter != nil {
			if f.Filter.Enabled != nil {
				serverFilter = *f.Filter.Enabled
			}
			if f.Filter.Pushdown != nil {
				serverFilter = serverFilter && *f.Filter.Pushdown
			}
		}

		sortable := true
		sortExpr := pg.Expr
		if f.Sort != nil {
			if f.Sort.Enabled != nil {
				sortable = *f.Sort.Enabled
			}
			if f.Sort.Field != "" {
				if e, ok := exprByName[f.Sort.Field]; ok {
					sortExpr = e
				}
			}
		}

		s.Fields[f.Name] = FieldSpec{
			Name:         f.Name,
			Kind:         kind,
			Expr:         pg.Expr,
			Synthetic:    pg.Synthetic,
			ServerFilter: serverFilter,
			Sortable:     sortable,
			SortExpr:     sortExpr,
		}
	}
	return s, nil
}
