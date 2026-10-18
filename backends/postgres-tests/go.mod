module query-table-postgres-tests

go 1.25

replace github.com/Pythia-Software/query-table/backends/go => ../go

require (
	github.com/Pythia-Software/query-table/backends/go v0.8.0
	github.com/lib/pq v1.12.3
)
