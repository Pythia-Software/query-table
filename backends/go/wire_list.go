package querytable

import "encoding/json"

// WireList is a list the wire schema requires: a nil WireList encodes as []
// rather than null. Its encoding is a method of the field, never of the
// struct, so a host's struct that embeds a wire type keeps its own fields.
// A []T assigns to it unchanged.
type WireList[T any] []T

func (l WireList[T]) MarshalJSON() ([]byte, error) {
	if l == nil {
		return []byte("[]"), nil
	}
	return json.Marshal([]T(l))
}

// WireMap is an object the wire schema requires: a nil WireMap encodes as {}.
type WireMap[V any] map[string]V

func (m WireMap[V]) MarshalJSON() ([]byte, error) {
	if m == nil {
		return []byte("{}"), nil
	}
	return json.Marshal(map[string]V(m))
}
