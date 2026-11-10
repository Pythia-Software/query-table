package querytable

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Metric intervals (AggSpec.Interval), mirroring packages/core/src/metricIntervals.ts.
//
// The metric must be a ratio of two additive aggregates, numerator over
// denominator (SUM, COUNT or COUNT_DISTINCT), multiplied or divided only by
// positive constants, with NULLIF(x, 0) allowed around either part. The
// compiler returns both reductions beside the value (interval_numerator and
// interval_denominator), and readV2Metric derives the bounds from them:
//
//   - proportion: the Wilson score interval, for 0 <= numerator <= denominator;
//   - rate: the exact (Garwood) Poisson interval on the numerator, divided by
//     the denominator.
//
// Bounds are scaled like the value. A bucket with an error or without a
// numeric value has none. Parts outside the kind's domain replace the value
// with the interval_domain error in SQL, before ranking, minCount and the
// group limit, as the TypeScript engines do when they build each bucket.
// schema/fixtures/metric-intervals.json holds the cases every engine
// reproduces.

// DefaultMetricIntervalLevel is the confidence level of an interval without one.
const DefaultMetricIntervalLevel = 0.95

// metricRatio is value = scale × numerator / denominator.
type metricRatio struct {
	numerator, denominator *exprNode
	scale                  float64
}

const metricIntervalShape = "an interval needs a ratio of two aggregates (SUM, COUNT or COUNT_DISTINCT), multiplied or divided only by positive constants"

// metricRatioParts finds the numerator, denominator and constant scale of a
// ratio metric.
func metricRatioParts(n *exprNode) (metricRatio, error) {
	var above, below []*exprNode
	scale := 1.0
	var visit func(*exprNode, bool) error
	visit = func(n *exprNode, up bool) error {
		op := strings.ToUpper(n.op)
		switch {
		case op == "LITERAL":
			v, ok := n.value.(float64)
			if !ok || !(v > 0) || math.IsInf(v, 0) {
				return diagnostic(ErrorCodeMetricInterval, metricIntervalShape)
			}
			if up {
				scale *= v
			} else {
				scale /= v
			}
			return nil
		case op == "SUM" || op == "COUNT" || op == "COUNT_DISTINCT":
			if up {
				above = append(above, n)
			} else {
				below = append(below, n)
			}
			return nil
		case (op == "*" || op == "/") && len(n.args) == 2:
			if err := visit(n.args[0], up); err != nil {
				return err
			}
			return visit(n.args[1], up == (op == "*"))
		case op == "UNARY+" && len(n.args) == 1:
			return visit(n.args[0], up)
		case op == "NULLIF" && len(n.args) == 2 && n.args[1].op == "literal" && n.args[1].value == float64(0):
			// NULLIF(x, 0) only turns a zero into no value, which has no interval.
			return visit(n.args[0], up)
		}
		return diagnostic(ErrorCodeMetricInterval, metricIntervalShape)
	}
	if err := visit(n, true); err != nil {
		return metricRatio{}, err
	}
	if len(above) != 1 || len(below) != 1 || math.IsInf(scale, 0) || !(scale > 0) {
		return metricRatio{}, diagnostic(ErrorCodeMetricInterval, metricIntervalShape)
	}
	return metricRatio{numerator: above[0], denominator: below[0], scale: scale}, nil
}

// validateMetricInterval checks an interval's options and the metric's shape.
func validateMetricInterval(spec AggSpec) (metricRatio, error) {
	interval := spec.Interval
	if interval.Kind != "proportion" && interval.Kind != "rate" {
		return metricRatio{}, diagnostic(ErrorCodeMetricInterval, `interval kind must be "proportion" or "rate"`)
	}
	if interval.Level != nil && !(*interval.Level > 0 && *interval.Level < 1) {
		return metricRatio{}, diagnostic(ErrorCodeMetricInterval, "interval level must be between 0 and 1")
	}
	if spec.Distribution != nil || spec.ExpressionY != "" || (spec.Display != nil && spec.Display.Kind == "scatter") {
		return metricRatio{}, diagnostic(ErrorCodeMetricInterval, "intervals apply to single-value metrics, not distributions or scatters")
	}
	n, err := parseExpression(metricExpression(spec))
	if err != nil {
		return metricRatio{}, err
	}
	return metricRatioParts(n)
}

// metricIntervalKey separates otherwise identical plans whose bounds differ.
func metricIntervalKey(spec AggSpec) string {
	if spec.Interval == nil {
		return ""
	}
	level := DefaultMetricIntervalLevel
	if spec.Interval.Level != nil {
		level = *spec.Interval.Level
	}
	return spec.Interval.Kind + "@" + strconv.FormatFloat(level, 'g', -1, 64)
}

// applyMetricInterval sets a bucket's bounds from its numerator and
// denominator, as returned by the driver (nil when NULL or an error).
func applyMetricInterval(b *MetricBucket, interval *MetricInterval, scale float64, numerator, denominator any) {
	if b.Error != "" {
		return
	}
	if _, ok := b.Value.(float64); !ok {
		return
	}
	n, okN := intervalNumber(numerator)
	d, okD := intervalNumber(denominator)
	if !okN || !okD {
		return
	}
	// The compiled plan already turned domain violations into errors.
	if lower, upper, ok, domain := metricIntervalBounds(interval, n, d, scale); ok && !domain {
		b.Lower, b.Upper = &lower, &upper
	}
}

func intervalNumber(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int64:
		return float64(x), true
	case []byte:
		n, err := strconv.ParseFloat(string(x), 64)
		return n, err == nil
	case string:
		n, err := strconv.ParseFloat(x, 64)
		return n, err == nil
	}
	return 0, false
}

// metricIntervalBounds returns the interval of scale × numerator /
// denominator. ok is false when there is none (a zero or non-finite part);
// domain is true when the parts are outside the kind's domain.
func metricIntervalBounds(interval *MetricInterval, numerator, denominator, scale float64) (lower, upper float64, ok, domain bool) {
	if math.IsNaN(numerator) || math.IsInf(numerator, 0) || math.IsNaN(denominator) || math.IsInf(denominator, 0) || denominator == 0 {
		return 0, 0, false, false
	}
	level := DefaultMetricIntervalLevel
	if interval.Level != nil {
		level = *interval.Level
	}
	alpha := 1 - level
	if interval.Kind == "proportion" {
		if numerator < 0 || denominator < 0 || numerator > denominator {
			return 0, 0, false, true
		}
		// Wilson score bounds, each from the stable root of the quadratic.
		z := normalQuantile(alpha)
		z2, n := z*z, denominator
		p, q := numerator/n, (n-numerator)/n
		spread := z * math.Sqrt(p*q/n+z2/(4*n*n))
		shift := z2 / (2 * n)
		lower, upper = 0, 1
		if p != 0 {
			lower = p * p / (p + shift + spread)
		}
		if q != 0 {
			upper = 1 - q*q/(q+shift+spread)
		}
	} else {
		if numerator < 0 || denominator < 0 {
			return 0, 0, false, true
		}
		if numerator != 0 {
			lower = gammaQuantile(alpha/2, numerator)
		}
		upper = gammaQuantile(1-alpha/2, numerator+1)
		lower /= denominator
		upper /= denominator
	}
	return scale * lower, scale * upper, true, false
}

// normalQuantile is the two-sided standard normal quantile: P(|Z| <= z) =
// 1 - alpha, from the regularized gamma function with shape 1/2.
func normalQuantile(alpha float64) float64 {
	return math.Sqrt(2 * gammaQuantile(1-alpha, 0.5))
}

// ---- Regularized incomplete gamma (Numerical Recipes, 3rd ed., 6.2) --------
// The TypeScript port uses the same algorithms, so both return the same
// bounds to within a few units in the last place.

const gammaEps = 2.220446049250313e-16

var gammaFPMin = math.SmallestNonzeroFloat64 / gammaEps

var lanczos = [9]float64{
	0.99999999999980993, 676.5203681218851, -1259.1392167224028,
	771.32342877765313, -176.61502916214059, 12.507343278686905,
	-0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
}

// logGamma is ln Γ(x) for x > 0 (Lanczos, g = 7).
func logGamma(x float64) float64 {
	if x < 0.5 {
		return math.Log(math.Pi/math.Sin(math.Pi*x)) - logGamma(1-x)
	}
	x--
	sum := lanczos[0]
	for i := 1; i < 9; i++ {
		sum += lanczos[i] / (x + float64(i))
	}
	t := x + 7.5
	return 0.5*math.Log(2*math.Pi) + (x+0.5)*math.Log(t) - t + math.Log(sum)
}

// 18-point Gauss-Legendre nodes and weights on [0, 1].
var gaussNodes, gaussWeights = gaussLegendre(18)

func gaussLegendre(n int) ([]float64, []float64) {
	nodes, weights := make([]float64, n), make([]float64, n)
	for i := 1; i <= n/2; i++ {
		z := math.Cos(math.Pi * (float64(i) - 0.25) / (float64(n) + 0.5))
		derivative := 0.0
		for step := 0; step < 100; step++ {
			p1, p2 := 1.0, 0.0
			for j := 1; j <= n; j++ {
				p3 := p2
				p2 = p1
				p1 = ((2*float64(j)-1)*z*p2 - (float64(j)-1)*p3) / float64(j)
			}
			derivative = float64(n) * (z*p1 - p2) / (z*z - 1)
			previous := z
			z = previous - p1/derivative
			if math.Abs(z-previous) <= 1e-15 {
				break
			}
		}
		weight := 1 / ((1 - z*z) * derivative * derivative)
		nodes[i-1], nodes[n-i] = 0.5-0.5*z, 0.5+0.5*z
		weights[i-1], weights[n-i] = weight, weight
	}
	return nodes, weights
}

// gammaPQuadrature is P(a, x) by quadrature, for a >= 100 where the series
// and continued fraction need O(√a) terms.
func gammaPQuadrature(a, x float64) float64 {
	a1 := a - 1
	lna1, root := math.Log(a1), math.Sqrt(a1)
	var xu float64
	if x > a1 {
		xu = math.Max(a1+11.5*root, x+6*root)
	} else {
		xu = math.Max(0, math.Min(a1-7.5*root, x-5*root))
	}
	sum := 0.0
	for j := range gaussNodes {
		t := x + (xu-x)*gaussNodes[j]
		sum += gaussWeights[j] * math.Exp(-(t-a1)+a1*(math.Log(t)-lna1))
	}
	tail := sum * (xu - x) * math.Exp(a1*(lna1-1)-logGamma(a))
	if tail > 0 {
		return 1 - tail
	}
	return -tail
}

// gammaP is the regularized lower incomplete gamma function P(a, x).
func gammaP(a, x float64) float64 {
	if x <= 0 {
		return 0
	}
	if a >= 100 {
		return gammaPQuadrature(a, x)
	}
	prefix := math.Exp(-x + a*math.Log(x) - logGamma(a))
	if x < a+1 {
		ap, term := a, 1/a
		sum := term
		for i := 0; i < 100000; i++ {
			ap++
			term *= x / ap
			sum += term
			if math.Abs(term) < math.Abs(sum)*gammaEps {
				break
			}
		}
		return sum * prefix
	}
	// Continued fraction for Q(a, x), modified Lentz.
	b := x + 1 - a
	c, d := 1/gammaFPMin, 1/b
	h := d
	for i := 1; i < 100000; i++ {
		an := -float64(i) * (float64(i) - a)
		b += 2
		d = an*d + b
		if math.Abs(d) < gammaFPMin {
			d = gammaFPMin
		}
		c = b + an/c
		if math.Abs(c) < gammaFPMin {
			c = gammaFPMin
		}
		d = 1 / d
		delta := d * c
		h *= delta
		if math.Abs(delta-1) <= gammaEps {
			break
		}
	}
	return 1 - prefix*h
}

// gammaQuantile is x such that P(a, x) = p: the p quantile of Gamma(a, 1).
func gammaQuantile(p, a float64) float64 {
	if !(a > 0) || !(p > 0 && p < 1) {
		panic(fmt.Sprintf("invalid gamma quantile p=%v a=%v", p, a))
	}
	a1, gln := a-1, logGamma(a)
	var x, lna1, afac float64
	if a > 1 {
		lna1 = math.Log(a1)
		afac = math.Exp(a1*(lna1-1) - gln)
		pp := p
		if p >= 0.5 {
			pp = 1 - p
		}
		t := math.Sqrt(-2 * math.Log(pp))
		guess := (2.30753+t*0.27061)/(1+t*(0.99229+t*0.04481)) - t
		if p < 0.5 {
			guess = -guess
		}
		x = math.Max(1e-3, a*math.Pow(1-1/(9*a)-guess/(3*math.Sqrt(a)), 3))
	} else {
		t := 1 - a*(0.253+a*0.12)
		if p < t {
			x = math.Pow(p/t, 1/a)
		} else {
			x = 1 - math.Log(1-(p-t)/(1-t))
		}
	}
	// Halley's method.
	for i := 0; i < 100; i++ {
		if x <= 0 {
			return 0
		}
		err := gammaP(a, x) - p
		var density float64
		if a > 1 {
			density = afac * math.Exp(-(x-a1)+a1*(math.Log(x)-lna1))
		} else {
			density = math.Exp(-x + a1*math.Log(x) - gln)
		}
		u := err / density
		step := u / (1 - 0.5*math.Min(1, u*(a1/x-1)))
		x -= step
		if x <= 0 {
			x = 0.5 * (x + step)
		}
		if math.Abs(step) <= 1e-12*x {
			break
		}
	}
	return x
}
