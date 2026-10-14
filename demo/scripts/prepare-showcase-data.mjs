import { DuckDBInstance } from "@duckdb/node-api";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Temporal } from "temporal-polyfill";

const root = fileURLToPath(new URL("../../", import.meta.url));
const destination = resolve(root, "demo/public/data");
const cache = resolve(root, ".context/dataset-cache");
await mkdir(cache, { recursive: true });
await mkdir(destination, { recursive: true });
const wanted = process.argv.slice(2);
const selected = wanted.length ? wanted : ["311", "trips", "food"];
const instance = await DuckDBInstance.create(":memory:", {
  threads: "2",
  memory_limit: "512MB",
});
const connection = await instance.connect();
await connection.run("SET TimeZone='UTC'");
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function download(url, path) {
  try {
    return await readFile(path);
  } catch {}
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error(`Download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(`${path}.tmp`, bytes);
  await rename(`${path}.tmp`, path);
  return bytes;
}
async function parquet(name, records, provenance) {
  if (
    !records.length ||
    new Set(records.map((row) => row.id)).size !== records.length
  )
    throw Error(`Invalid ${name} identities.`);
  const jsonPath = resolve(cache, `${name}-normalized.json`);
  await writeFile(jsonPath, JSON.stringify(records));
  const output = resolve(destination, `${name}.parquet`),
    temporary = `${output}.tmp`;
  await connection.run(
    `COPY (SELECT * FROM read_json_auto(${quote(jsonPath)}, maximum_object_size=16777216, sample_size=-1)) TO ${quote(temporary)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 2048)`,
  );
  const bytes = await readFile(temporary);
  await rename(temporary, output);
  const manifest = {
    id: name,
    file: `${name}.parquet`,
    rows: records.length,
    bytes: bytes.length,
    sha256: sha(bytes),
    preparedAt: new Date().toISOString(),
    ...provenance,
  };
  await writeFile(
    resolve(destination, `${name}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(
    `${name}: ${records.length.toLocaleString()} rows, ${(bytes.length / 1024 / 1024).toFixed(2)} MiB`,
  );
}
const number = (value) =>
  value === null ||
  value === undefined ||
  value === "" ||
  !Number.isFinite(Number(value))
    ? null
    : Number(value);
const isoNY = (value) =>
  value
    ? Temporal.PlainDateTime.from(value)
        .toZonedDateTime("America/New_York")
        .toInstant()
        .toString()
    : null;
if (selected.includes("311")) {
  const endpoint = "https://data.cityofnewyork.us/resource/erm2-nwe9.json";
  const url = new URL(endpoint);
  url.searchParams.set(
    "$where",
    "created_date >= '2025-01-01T00:00:00' AND created_date < '2025-02-01T00:00:00' AND unique_key::number % 17 = 0",
  );
  url.searchParams.set("$order", "unique_key ASC");
  url.searchParams.set("$limit", "30000");
  const bytes = await download(
    url.href,
    resolve(cache, "311-january-2025.json"),
  );
  const raw = JSON.parse(bytes);
  const records = raw.map((row) => {
    const created = isoNY(row.created_date),
      closed = isoNY(row.closed_date);
    const duration = closed
      ? (Date.parse(closed) - Date.parse(created)) / 1000
      : null;
    return {
      id: row.unique_key,
      created_at: created,
      closed_at: closed,
      created_day: row.created_date.slice(0, 10),
      agency: row.agency,
      agency_name: row.agency_name,
      problem: row.complaint_type,
      problem_detail: row.descriptor ?? null,
      additional_details: row.descriptor_2 ?? null,
      status: row.status,
      borough: row.borough,
      city: row.city ?? null,
      channel: row.open_data_channel_type,
      location_type: row.location_type ?? null,
      zip: row.incident_zip ?? null,
      address: row.incident_address ?? null,
      street: row.street_name ?? null,
      community_board: row.community_board ?? null,
      council_district: row.council_district ?? null,
      precinct: row.police_precinct ?? null,
      latitude: number(row.latitude),
      longitude: number(row.longitude),
      resolution: row.resolution_description ?? null,
      closure_seconds: duration !== null && duration >= 0 ? duration : null,
      is_closed: row.status === "Closed",
      age_at_snapshot_seconds: Math.max(
        0,
        (Date.parse("2025-02-01T05:00:00Z") - Date.parse(created)) / 1000,
      ),
      location: row.location ? JSON.stringify(row.location) : null,
    };
  });
  await parquet("311", records, {
    title: "NYC 311 service requests",
    source: "NYC Open Data",
    sourceUrl:
      "https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2020-to-Present/erm2-nwe9/about_data",
    downloadUrl: url.href,
    sourceSha256: sha(bytes),
    license: "NYC Open Data terms of use",
    licenseUrl: "https://opendata.cityofnewyork.us/overview/#termsofuse",
    cohort:
      "January 2025 requests with unique key divisible by 17. Status and closure fields reflect the export, not historical status on February 1.",
    snapshotAt: "2025-02-01T05:00:00Z",
    transformations:
      "Local source dates interpreted in America/New_York, including DST for closures outside January. Created day retains the local calendar date. Closure duration and age at the fixed reference date are derived; negative closure durations are null.",
  });
}
if (selected.includes("trips")) {
  const url =
    "https://d37ci6vzurychx.cloudfront.net/trip-data/yellow_tripdata_2025-01.parquet";
  const path = resolve(cache, "yellow_tripdata_2025-01.parquet"),
    bytes = await download(url, path);
  const zoneUrl =
      "https://d37ci6vzurychx.cloudfront.net/misc/taxi_zone_lookup.csv",
    zones = resolve(cache, "taxi_zone_lookup.csv");
  await download(zoneUrl, zones);
  await connection.run(
    `CREATE TABLE zones AS SELECT * FROM read_csv_auto(${quote(zones)})`,
  );
  const result =
    await connection.runAndReadAll(`WITH numbered AS (SELECT row_number() OVER () AS original_row, * FROM read_parquet(${quote(path)}))
    SELECT '2025-01:' || original_row AS id,
      strftime(tpep_pickup_datetime, '%Y-%m-%dT%H:%M:%S') || '-05:00' AS pickup_at,
      strftime(tpep_dropoff_datetime, '%Y-%m-%dT%H:%M:%S') || '-05:00' AS dropoff_at,
      strftime(tpep_pickup_datetime, '%Y-%m-%d') AS pickup_day, hour(tpep_pickup_datetime) AS pickup_hour,
      VendorID AS vendor, passenger_count AS passengers, trip_distance AS distance_miles,
      date_diff('second', tpep_pickup_datetime, tpep_dropoff_datetime) AS duration_seconds,
      pu.Borough AS pickup_borough, pu.Zone AS pickup_zone, doff.Borough AS dropoff_borough, doff.Zone AS dropoff_zone,
      CASE payment_type WHEN 0 THEN 'Flex fare' WHEN 1 THEN 'Credit card' WHEN 2 THEN 'Cash' WHEN 3 THEN 'No charge' WHEN 4 THEN 'Dispute' WHEN 5 THEN 'Unknown' WHEN 6 THEN 'Voided' ELSE 'Unknown' END AS payment,
      CASE RatecodeID WHEN 1 THEN 'Standard' WHEN 2 THEN 'JFK' WHEN 3 THEN 'Newark' WHEN 4 THEN 'Nassau / Westchester' WHEN 5 THEN 'Negotiated' WHEN 6 THEN 'Group' ELSE 'Unknown' END AS rate,
      fare_amount AS fare, tip_amount AS tip, total_amount AS total, tolls_amount AS tolls, extra, mta_tax, improvement_surcharge, congestion_surcharge, cbd_congestion_fee,
      store_and_fwd_flag = 'Y' AS stored_offline,
      CASE WHEN fare_amount > 0 THEN tip_amount / fare_amount ELSE NULL END AS tip_ratio,
      CASE WHEN trip_distance > 0 THEN total_amount / trip_distance ELSE NULL END AS dollars_per_mile,
      CASE WHEN date_diff('second', tpep_pickup_datetime,tpep_dropoff_datetime)>0 THEN trip_distance / (date_diff('second', tpep_pickup_datetime,tpep_dropoff_datetime)/3600.0) ELSE NULL END AS speed_mph
    FROM numbered LEFT JOIN zones pu ON PULocationID=pu.LocationID LEFT JOIN zones doff ON DOLocationID=doff.LocationID
    WHERE original_row % 101 = 0 AND tpep_pickup_datetime >= '2025-01-01' AND tpep_pickup_datetime < '2025-02-01'`);
  const records = result
    .getRowObjectsJS()
    .map((row) =>
      JSON.parse(
        JSON.stringify(row, (_, value) =>
          typeof value === "bigint" ? Number(value) : value,
        ),
      ),
    );
  await parquet("trips", records, {
    title: "NYC yellow taxi trips",
    source: "NYC Taxi & Limousine Commission",
    sourceUrl: "https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page",
    downloadUrl: url,
    sourceSha256: sha(bytes),
    license: "NYC TLC public trip records",
    licenseUrl: "https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page",
    cohort:
      "Every 101st source record with a January 2025 pickup. Cash tips are not recorded. This is a sample, not citywide totals.",
    transformations:
      "Zone lookup joined before export; EST timestamp offsets, duration, tip ratio, dollars per mile and speed derived. Source anomalies retained.",
  });
}
if (selected.includes("food")) {
  const meta = await (
    await fetch(
      "https://huggingface.co/api/datasets/openfoodfacts/product-database",
    )
  ).json();
  const revision = meta.sha;
  if (!/^[0-9a-f]{40}$/.test(revision))
    throw Error("Missing Food Facts snapshot revision.");
  const url = `https://huggingface.co/datasets/openfoodfacts/product-database/resolve/${revision}/food.parquet`;
  await connection.run("INSTALL httpfs");
  await connection.run("LOAD httpfs");
  const cachePath = resolve(cache, `food-${revision}.json`);
  let raw;
  try {
    raw = JSON.parse(await readFile(cachePath, "utf8"));
  } catch {
    console.log("Reading a bounded Food Facts Parquet cohort…");
    const result =
      await connection.runAndReadAll(`SELECT code, product_name, brands, categories_tags, food_groups_tags, countries_tags, labels_tags, allergens_tags, additives_tags, ingredients_analysis_tags,
      ingredients_text, ingredients, nutriments, nutriscore_grade, nutriscore_score, nova_group, completeness, created_t, last_modified_t, obsolete, no_nutrition_data, quantity, serving_size, packagings
      FROM read_parquet(${quote(url)}) LIMIT 8000`);
    raw = JSON.parse(
      JSON.stringify(result.getRowObjectsJS(), (_, value) =>
        typeof value === "bigint" ? Number(value) : value,
      ),
    );
    await writeFile(cachePath, JSON.stringify(raw));
  }
  const text = (values) =>
    typeof values === "string"
      ? values
      : (values?.find((item) => item.lang === "en")?.text ??
        values?.find((item) => item.lang === "main")?.text ??
        values?.[0]?.text ??
        null);
  const labels = (values) =>
    (values ?? []).map((value) =>
      value.replace(/^[a-z]{2}:/, "").replaceAll("-", " "),
    );
  const records = raw
    .filter((row) => text(row.product_name))
    .map((row) => {
      const nutriments = row.nutriments ?? [],
        nutrient = (name) =>
          number(nutriments.find((item) => item.name === name)?.["100g"]);
      return {
        id: String(row.code),
        product: text(row.product_name),
        brand: row.brands ?? null,
        category:
          labels(row.food_groups_tags)?.[0] ??
          labels(row.categories_tags)?.[0] ??
          "Uncategorized",
        categories: labels(row.categories_tags),
        countries: labels(row.countries_tags),
        labels: labels(row.labels_tags),
        allergens: labels(row.allergens_tags),
        additives: labels(row.additives_tags),
        dietary_tags: labels(row.ingredients_analysis_tags),
        grade: row.nutriscore_grade ?? null,
        nutrition_score: number(row.nutriscore_score),
        processing_group: number(row.nova_group),
        sugar_g: nutrient("sugars"),
        protein_g: nutrient("proteins"),
        fat_g: nutrient("fat"),
        salt_g: nutrient("salt"),
        fiber_g: nutrient("fiber"),
        energy_kcal: nutrient("energy-kcal"),
        completeness: number(row.completeness),
        quantity: row.quantity ?? null,
        serving_size: row.serving_size ?? null,
        created_at: row.created_t
          ? new Date(row.created_t * 1000).toISOString()
          : null,
        modified_at: row.last_modified_t
          ? new Date(row.last_modified_t * 1000).toISOString()
          : null,
        obsolete: row.obsolete ?? false,
        no_nutrition_data: row.no_nutrition_data ?? false,
        ingredients_text: text(row.ingredients_text),
        ingredients: row.ingredients ?? null,
        nutrients: JSON.stringify(nutriments),
        packaging: JSON.stringify(row.packagings ?? []),
        product_url: `https://world.openfoodfacts.org/product/${row.code}`,
      };
    });
  const unique = [...new Map(records.map((row) => [row.id, row])).values()];
  await parquet("food", unique, {
    title: "Open Food Facts products",
    source: "Open Food Facts",
    sourceUrl: "https://huggingface.co/datasets/openfoodfacts/product-database",
    downloadUrl: url,
    sourceRevision: revision,
    sourceSha256: sha(Buffer.from(JSON.stringify(raw))),
    license: "Open Database License (ODbL)",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
    cohort:
      "First 8,000 source records, retaining named products and deduplicating barcodes. This is a curated source-order cohort, not a representative sample of the food market.",
    transformations:
      "English/main name selected; namespace prefixes removed from displayed tags. Nutrients are per 100g/100ml as supplied. A single category is chosen for exclusive grouping; original category tags retained. Missing allergen tags do not establish allergen absence.",
  });
}
connection.closeSync();
