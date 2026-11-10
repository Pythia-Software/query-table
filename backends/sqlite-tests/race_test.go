//go:build race

package sqlitetests

// raceEnabled lets the largest population tests shrink under the race
// detector, which slows the pure-Go SQLite driver about tenfold.
const raceEnabled = true
