# Demo data licenses and provenance

The repository's MIT code license does not replace these datasets' source terms.

- `311.parquet`: NYC Open Data 311 service requests. Source and terms:
  https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2020-to-Present/erm2-nwe9/about_data
- `trips.parquet`: NYC Taxi & Limousine Commission public yellow trip records,
  joined with the TLC zone lookup. Source and data dictionaries:
  https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page
- `food.parquet`: Open Food Facts database, under the Open Database License
  (ODbL 1.0), with individual contents under Database Contents License.
  https://huggingface.co/datasets/openfoodfacts/product-database
  https://opendatacommons.org/licenses/odbl/1-0/
  https://opendatacommons.org/licenses/dbcl/1-0/

These downloadable files are the same prepared cohorts used by the demo. The
adjacent JSON manifests document sampling, source URLs/revisions, hashes, and
transformations. They contain real source values, not generated example records.
No product images are included. Regeneration is documented in
`docs/public-demo.md`.
