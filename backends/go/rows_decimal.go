package querytable

import (
	"database/sql/driver"
	"math"
	"math/big"
	"strconv"
)

// Accumulate the shortest decimal rendering of each input at its own scale.
// No input rescaling or rational reduction is needed in the row loop. Keep the
// first scale inline so integer-only metrics need no bucket allocation.
type rowDecimalAggregate struct {
	n     int64
	first rowDecimalPart
	other []rowDecimalPart
}

type rowDecimalPart struct {
	scale    int
	sum, abs int64
	large    *rowDecimalLarge
}

type rowDecimalLarge struct{ sum, abs big.Int }

// The caller has already rejected nonfinite, out-of-range and unsafe integral
// inputs. A shortest float64 rendering has at most 17 significant digits, so
// its coefficient fits int64 even at scales beyond 300.
func rowDecimalParts(n float64) (int64, int) {
	if math.Trunc(n) == n {
		return int64(n), 0
	}
	var buf [32]byte
	text := strconv.AppendFloat(buf[:0], n, 'g', -1, 64)
	coefficient := int64(0)
	scale := 0
	negative, fraction := false, false
	i := 0
	if text[0] == '-' {
		negative = true
		i++
	}
	for ; i < len(text) && text[i] != 'e'; i++ {
		if text[i] == '.' {
			fraction = true
			continue
		}
		coefficient = coefficient*10 + int64(text[i]-'0')
		if fraction {
			scale++
		}
	}
	if i < len(text) {
		i++
		sign := 1
		if text[i] == '-' {
			sign = -1
			i++
		} else if text[i] == '+' {
			i++
		}
		exponent := 0
		for ; i < len(text); i++ {
			exponent = exponent*10 + int(text[i]-'0')
		}
		scale -= sign * exponent
	}
	if negative {
		coefficient = -coefficient
	}
	return coefficient, scale
}

func (a *rowDecimalAggregate) add(n float64) {
	coefficient, scale := rowDecimalParts(n)
	if a.n == 0 {
		a.first.scale = scale
	}
	a.n++
	if scale == a.first.scale {
		a.first.add(coefficient)
		return
	}
	for i := range a.other {
		if a.other[i].scale == scale {
			a.other[i].add(coefficient)
			return
		}
	}
	a.other = append(a.other, rowDecimalPart{scale: scale})
	a.other[len(a.other)-1].add(coefficient)
}

func (p *rowDecimalPart) add(coefficient int64) {
	magnitude := coefficient
	if magnitude < 0 {
		magnitude = -magnitude
	}
	// The absolute sum also bounds the signed sum. Spill only when this part
	// fills int64, then resume int64 additions until the next spill.
	if p.abs > math.MaxInt64-magnitude {
		if p.large == nil {
			p.large = &rowDecimalLarge{}
		}
		var v big.Int
		p.large.sum.Add(&p.large.sum, v.SetInt64(p.sum))
		p.large.abs.Add(&p.large.abs, v.SetInt64(p.abs))
		p.sum, p.abs = 0, 0
	}
	p.sum += coefficient
	p.abs += magnitude
}

func (p *rowDecimalPart) accumulate(sum, abs *big.Int, scale int) {
	var factor, coefficient big.Int
	factor.Exp(big.NewInt(10), big.NewInt(int64(scale-p.scale)), nil)
	coefficient.SetInt64(p.sum)
	if p.large != nil {
		coefficient.Add(&coefficient, &p.large.sum)
	}
	coefficient.Mul(&coefficient, &factor)
	sum.Add(sum, &coefficient)
	coefficient.SetInt64(p.abs)
	if p.large != nil {
		coefficient.Add(&coefficient, &p.large.abs)
	}
	coefficient.Mul(&coefficient, &factor)
	abs.Add(abs, &coefficient)
}

func (a *rowDecimalAggregate) accumulator(op string) *sqliteV2Aggregate {
	scale := a.first.scale
	for i := range a.other {
		if a.other[i].scale > scale {
			scale = a.other[i].scale
		}
	}
	var sum, abs, denominator big.Int
	a.first.accumulate(&sum, &abs, scale)
	for i := range a.other {
		a.other[i].accumulate(&sum, &abs, scale)
	}
	denominator.Exp(big.NewInt(10), big.NewInt(int64(scale)), nil)
	// Reuse the SQLite implementation for final SUM bounds, AVG division,
	// decimal-domain checks and the single rounding to float64.
	return &sqliteV2Aggregate{op: op, n: a.n,
		sum: new(big.Rat).SetFrac(&sum, &denominator),
		abs: new(big.Rat).SetFrac(&abs, &denominator)}
}

func (a *rowDecimalAggregate) value(op string) (driver.Value, error) {
	return a.accumulator(op).Value()
}
