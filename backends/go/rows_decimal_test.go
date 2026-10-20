package querytable

import (
	"database/sql/driver"
	"math"
	"math/rand"
	"testing"
)

func TestRowsDecimalAccumulator(t *testing.T) {
	noise := make([]float64, 4000)
	spills := make([]float64, 4000)
	for i := range noise {
		noise[i] = float64(1834+i) * 0.30 / 1e6
		// Both decimal parts spill repeatedly, including across cancellation.
		spills[i] = []float64{1.2345678901234567, 0.12345678901234566, -1.2345678901234567, -0.12345678901234566}[i%4]
	}
	rng := rand.New(rand.NewSource(17))
	var mixed []float64
	for len(mixed) < 1000 {
		n := math.Float64frombits(rng.Uint64())
		if sqliteNumericError(n) == "" && !sqliteUnsafe(n) {
			mixed = append(mixed, n)
		}
	}
	for name, values := range map[string][]float64{
		"empty":               nil,
		"tenths":              {0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1},
		"float noise":         noise,
		"repeated spills":     spills,
		"mixed exponents":     mixed,
		"smallest decimals":   {1e-300, math.Nextafter(1e-300, 1), -1e-300},
		"result underflow":    {math.Nextafter(1e-300, 1), -1e-300},
		"absolute bound":      {1 << 52, 1 << 52, -1 << 52, -1 << 52},
		"fraction over bound": {sqliteSafeInteger, 1e-300},
		"at bound":            {sqliteSafeInteger, 0},
	} {
		t.Run(name, func(t *testing.T) {
			values = append([]float64(nil), values...)
			for order := range 3 {
				var got rowDecimalAggregate
				want := &sqliteV2Aggregate{}
				for i, n := range values {
					got.add(n)
					if err := want.Step([]driver.Value{n}); err != nil {
						t.Fatal(err)
					}
					if i == len(values)/2 {
						// Finalizing a snapshot must not change later additions.
						if _, err := got.value("avg"); err != nil {
							t.Fatal(err)
						}
					}
				}
				for _, op := range []string{"sum", "avg"} {
					want.op = op
					gv, ge := got.value(op)
					wv, we := want.Value()
					if ge != nil || we != nil || gv != wv {
						t.Fatalf("order %d %s: got %v (%v), want %v (%v)", order, op, gv, ge, wv, we)
					}
				}
				// Compare exact values too, so float rounding cannot hide lost
				// small terms, absolute magnitudes or cancellation.
				a := got.accumulator("sum")
				if a.n != want.n || a.n != 0 && (a.sum.Cmp(want.sum) != 0 || a.abs.Cmp(want.abs) != 0) {
					t.Fatalf("order %d: exact accumulators differ", order)
				}
				rng.Shuffle(len(values), func(i, j int) { values[i], values[j] = values[j], values[i] })
			}
		})
	}
}
