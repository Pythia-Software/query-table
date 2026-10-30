package querytable

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

var jsonInspectionPath = regexp.MustCompile(`^\$(?:\[(?:0|[1-9]\d*|"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*")\])*$`)
var jsonBucketIndex = regexp.MustCompile(`^(?:0|[1-9]\d*)$`)

func validJSONPath(v *jsValue) bool {
	return propertyString(v, 10000) && jsonInspectionPath.MatchString(v.s)
}
func validJSONBucket(v *jsValue) bool {
	if !propertyString(v, 10032) {
		return false
	}
	index := strings.LastIndex(v.s, ":bucket:")
	if index <= 0 || !validJSONPath(jsStr(v.s[:index])) || !jsonBucketIndex.MatchString(v.s[index+8:]) {
		return false
	}
	n, err := strconv.ParseFloat(v.s[index+8:], 64)
	return err == nil && n >= 20 && n <= 9007199254740991 && math.Mod(n, 20) == 0
}
func normalizeJSONPaths(value *jsValue, valid func(*jsValue) bool) *jsValue {
	if !value.isArray() || len(value.a) > 5000 {
		return nil
	}
	seen := map[string]bool{}
	out := jsArr()
	for _, path := range value.a {
		if !valid(path) || seen[path.s] {
			return nil
		}
		seen[path.s] = true
		out.a = append(out.a, path)
	}
	return out
}
func normalizeJSONInspection(input *jsValue) *jsValue {
	if !input.isRecord() {
		return nil
	}
	version, open, raw := input.get("version"), input.get("open"), input.get("raw")
	search, mode, limit := input.get("search"), input.get("searchMode"), input.get("visibleEntryLimit")
	if !version.isNumber() || version.n != 1 || (open == nil || open.kind != jsBool) || (raw == nil || raw.kind != jsBool) || !search.isString() || jsLength(search.s) > 10000 || !mode.isString() || (mode.s != "filter" && mode.s != "find") || !jsIsFinite(limit) || math.Trunc(limit.n) != limit.n || limit.n < 1 || limit.n > 10000 {
		return nil
	}
	collapsed, buckets := normalizeJSONPaths(input.get("collapsedPaths"), validJSONPath), normalizeJSONPaths(input.get("expandedBuckets"), validJSONBucket)
	if collapsed == nil || buckets == nil {
		return nil
	}
	out := jsObj().set("version", jsNum(1)).set("open", open).set("search", search).set("searchMode", mode).set("raw", raw).set("collapsedPaths", collapsed).set("expandedBuckets", buckets).set("visibleEntryLimit", limit).set("searchOverrides", jsArr())
	if match := input.get("selectedMatch"); match != nil {
		path, part, start := match.get("path"), match.get("part"), match.get("start")
		if !match.isRecord() || !validJSONPath(path) || !part.isString() || !includesString([]string{"key", "value", "path"}, part.s) || !jsIsFinite(start) || math.Trunc(start.n) != start.n || start.n < 0 || start.n > 1048576 {
			return nil
		}
		out.set("selectedMatch", jsObj().set("path", path).set("part", part).set("start", start))
	}
	overrides := input.get("searchOverrides")
	if !overrides.isArray() || len(overrides.a) > 5000 {
		return nil
	}
	seen := map[string]bool{}
	for _, entry := range overrides.a {
		path, expanded := entry.get("path"), entry.get("expanded")
		if !entry.isRecord() || (!validJSONPath(path) && !validJSONBucket(path)) || (expanded == nil || expanded.kind != jsBool) || seen[path.s] {
			return nil
		}
		seen[path.s] = true
		out.get("searchOverrides").a = append(out.get("searchOverrides").a, jsObj().set("path", path).set("expanded", expanded))
	}
	return out
}
func normalizeJSONInspections(input *jsValue) *jsValue {
	if !input.isArray() || len(input.a) > 200 {
		return nil
	}
	out := jsArr()
	seen := map[string]bool{}
	for _, entry := range input.a {
		dataset, row, field := entry.get("dataset"), entry.get("rowId"), entry.get("field")
		if !entry.isRecord() || !propertyString(dataset, 256) || !propertyString(field, 256) || (!propertyString(row, 1000) && !jsIsFinite(row)) {
			return nil
		}
		scope := jsArr()
		scope.a = append(scope.a, dataset, row, field)
		key := stringifyJS(scope)
		if seen[key] {
			return nil
		}
		seen[key] = true
		state := normalizeJSONInspection(entry.get("state"))
		if state == nil {
			return nil
		}
		out.a = append(out.a, jsObj().set("dataset", dataset).set("rowId", row).set("field", field).set("state", state))
	}
	return out
}

// JSONInspectionState is the version-1 portable JSON viewer definition carried
// by ItemDetailsState.jsonInspections. No hover, focus, copy feedback or geometry
// is included. Use NewJSONInspectionState so empty ordered sets encode as [].
type JSONInspectionState struct {
	Version           int                  `json:"version"`
	Open              bool                 `json:"open"`
	Search            string               `json:"search"`
	SearchMode        string               `json:"searchMode"` // "filter" or "find"
	Raw               bool                 `json:"raw"`
	CollapsedPaths    []string             `json:"collapsedPaths"`
	ExpandedBuckets   []string             `json:"expandedBuckets"`
	VisibleEntryLimit int                  `json:"visibleEntryLimit"`
	SearchOverrides   []JSONSearchOverride `json:"searchOverrides"`
	SelectedMatch     *JSONMatchIdentity   `json:"selectedMatch,omitempty"`
}
type JSONSearchOverride struct {
	Path     string `json:"path"`
	Expanded bool   `json:"expanded"`
}
type JSONMatchIdentity struct {
	Path  string `json:"path"`
	Part  string `json:"part"`
	Start int    `json:"start"`
}

// RowID is a string or finite JSON number. Numeric 0 and string "0" are distinct.
type ScopedJSONInspectionState struct {
	Dataset string              `json:"dataset"`
	RowID   any                 `json:"rowId"`
	Field   string              `json:"field"`
	State   JSONInspectionState `json:"state"`
}

func NewJSONInspectionState() JSONInspectionState {
	return JSONInspectionState{Version: 1, SearchMode: "filter", CollapsedPaths: []string{}, ExpandedBuckets: []string{}, VisibleEntryLimit: 200, SearchOverrides: []JSONSearchOverride{}}
}
