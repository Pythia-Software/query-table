import {
  normalizeQueryState,
  type AggregationClause,
  type FieldDef,
  type FieldSchema,
  type FieldType,
  type QueryState,
  type MetricValueFormat,
  type CellDisplay as FieldDisplay,
} from "@pythia-software/query-table-core";
export type DatasetId = "311" | "trips" | "food";
export interface DatasetManifest {
  id: DatasetId;
  title: string;
  rows: number;
  bytes: number;
  sha256: string;
  preparedAt: string;
  source: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
  cohort: string;
  transformations: string;
  file: string;
}
export interface Recipe {
  name: string;
  description: string;
  query: QueryState;
}
export interface Dataset {
  id: DatasetId;
  title: string;
  noun: string;
  color: string;
  schema: FieldSchema;
  defaults: QueryState;
  recipes: Recipe[];
}
const field = (
  name: string,
  label: string,
  type: FieldType,
  group: string,
  display?: FieldDisplay,
): FieldDef => ({
  name,
  label,
  type,
  group,
  source: { kind: "backend" },
  ...(type === "textarray"
    ? { filter: { editor: "set", arrayCaseSensitive: true } }
    : {}),
  ...(display?.kind === "json"
    ? {
        filter: { enabled: false },
        sort: { enabled: false },
        aggregate: { measure: false, groupable: false },
      }
    : {}),
  ...(type === "datetime" ? { aggregate: { groupable: true } } : {}),
  ...(display ? { display } : {}),
  select: { width: type === "textarray" ? 220 : type === "number" ? 120 : 180 },
});
const duration: FieldDisplay = {
  kind: "duration",
  sourceUnit: "seconds",
  style: "human",
};
const datetime: FieldDisplay = {
  kind: "datetime",
  sourceUnit: "iso",
  timeZone: "America/New_York",
};
const json: FieldDisplay = { kind: "json", encoding: "auto" };
const number: FieldDisplay = { kind: "number", decimals: 2 };
const percent: FieldDisplay = { kind: "percent", decimals: 1 };
const metric = (
  id: string,
  label: string,
  expression: string,
  groupBy: string[] = [],
  kind: "value" | "bar-horizontal" | "line" | "donut" | "table" = "value",
  format?: MetricValueFormat,
): AggregationClause => ({
  id,
  label,
  op: "count",
  expression,
  groupBy,
  groupLimit: 12,
  display: {
    kind,
    ...(format ? { format } : {}),
    ...(kind === "line"
      ? {
          xFormat: { kind: "date", style: "custom", pattern: "MMM DD" },
          xLabel: "January day",
          yLabel: "Count",
        }
      : {}),
  },
  ...(kind === "line"
    ? {
        // These fields preserve NYC calendar dates as civil ISO dates. Group
        // them in UTC so display and chart drilldown retain the same day.
        dateGrouping: {
          field: groupBy[0]!,
          interval: "day",
          timeZone: "UTC",
          includeEmpty: false,
          range: "observed",
        },
        sort: [{ key: "group0", dir: "asc" }],
        groupLimit: 40,
      }
    : {}),
  layout: {
    widthRem: kind === "value" ? 13 : 27,
    heightRem: kind === "value" ? 6 : 14,
    minWidthRem: 11,
    minHeightRem: 6,
  },
});
const select = (...names: string[]) => names.map((field) => ({ field }));
const schema = (
  id: DatasetId,
  fields: FieldDef[],
  columns: string[],
): FieldSchema => ({
  name: `showcase-v1:${id}`,
  idField: "id",
  fields: [
    {
      ...field("id", "Record ID", "text", "Identity"),
      aggregate: { groupable: false },
    },
    ...fields,
  ],
  defaultSelect: select(...columns),
  defaultLimit: 25,
});
const closureFormat = {
  kind: "duration",
  sourceUnit: "seconds",
  style: "human",
} as const;
const requestSchema = schema(
  "311",
  [
    field("problem", "Problem", "text", "Request"),
    field("problem_detail", "Problem detail", "text", "Request"),
    field("additional_details", "Additional details", "text", "Request"),
    field("status", "Status", "enum", "Request", {
      kind: "chip",
      tones: { Closed: "success", Open: "warning", Pending: "warning" },
    }),
    field("agency", "Agency", "enum", "Request"),
    field("agency_name", "Agency name", "text", "Request"),
    field("channel", "Intake channel", "enum", "Request"),
    field("created_at", "Created", "datetime", "Time", datetime),
    field("closed_at", "Closed", "datetime", "Time", datetime),
    field("created_day", "Created day", "datetime", "Time", { kind: "date" }),
    field("closure_seconds", "Time to close", "number", "Time", duration),
    field(
      "age_at_snapshot_seconds",
      "Age on Feb 1, 2025",
      "number",
      "Time",
      duration,
    ),
    field("is_closed", "Closed", "bool", "Request"),
    field("borough", "Borough", "enum", "Location"),
    field("city", "City", "text", "Location"),
    field("zip", "ZIP code", "text", "Location"),
    field("address", "Address", "text", "Location"),
    field("street", "Street", "text", "Location"),
    field("location_type", "Location type", "enum", "Location"),
    field("community_board", "Community board", "text", "Location"),
    field("council_district", "Council district", "text", "Location"),
    field("precinct", "Police precinct", "text", "Location"),
    field("latitude", "Latitude", "number", "Location", {
      kind: "number",
      decimals: 5,
    }),
    field("longitude", "Longitude", "number", "Location", {
      kind: "number",
      decimals: 5,
    }),
    field("resolution", "Resolution", "text", "Details"),
    field("location", "Location data", "text", "Details", json),
  ],
  [
    "problem",
    "status",
    "borough",
    "agency",
    "created_at",
    "closure_seconds",
    "__qt_item_details__",
  ],
);
const requestDefault = normalizeQueryState({
  select: requestSchema.defaultSelect,
  orderBy: [{ field: "created_at", dir: "desc" }],
  limit: 25,
  aggregations: [
    metric("requests", "Requests in this view", "COUNT()"),
    metric(
      "closed",
      "Closed share",
      "SUM(IF([is_closed], 1, 0)) / NULLIF(COUNT(), 0)",
      [],
      "value",
      percent,
    ),
    metric(
      "closure",
      "Median time to close",
      "MEDIAN([closure_seconds])",
      [],
      "value",
      closureFormat,
    ),
    metric(
      "problems",
      "Most reported problems",
      "COUNT()",
      ["problem"],
      "bar-horizontal",
    ),
    metric("boroughs", "Requests by borough", "COUNT()", ["borough"], "donut"),
    metric(
      "days",
      "Requests through January",
      "COUNT()",
      ["created_day"],
      "line",
    ),
  ],
});
const tripSchema = schema(
  "trips",
  [
    field("pickup_at", "Pickup", "datetime", "Time", datetime),
    field("dropoff_at", "Drop-off", "datetime", "Time", datetime),
    field("pickup_day", "Pickup day", "datetime", "Time", { kind: "date" }),
    field("pickup_hour", "Pickup hour", "number", "Time"),
    field("duration_seconds", "Duration", "number", "Time", duration),
    ...["pickup_borough", "dropoff_borough", "pickup_zone", "dropoff_zone"].map(
      (name) =>
        field(
          name,
          name
            .replace(/_/g, " ")
            .replace(/^./, (letter) => letter.toUpperCase()),
          "text",
          "Route",
        ),
    ),
    field("payment", "Payment", "enum", "Trip", { kind: "chip" }),
    field("rate", "Rate", "enum", "Trip"),
    field("passengers", "Passengers", "number", "Trip"),
    field("vendor", "Vendor", "enum", "Trip"),
    field("stored_offline", "Stored offline", "bool", "Trip"),
    field("distance_miles", "Distance (mi)", "number", "Measures", number),
    field("speed_mph", "Speed (mph)", "number", "Measures", number),
    ...[
      "fare",
      "tip",
      "total",
      "tolls",
      "extra",
      "mta_tax",
      "improvement_surcharge",
      "congestion_surcharge",
      "cbd_congestion_fee",
      "dollars_per_mile",
    ].map((name) =>
      field(
        name,
        `${name.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase())} ($)`,
        "number",
        "Amounts",
        number,
      ),
    ),
    field("tip_ratio", "Tip / fare", "number", "Amounts", percent),
  ],
  [
    "pickup_at",
    "pickup_zone",
    "dropoff_zone",
    "duration_seconds",
    "distance_miles",
    "total",
    "payment",
    "__qt_item_details__",
  ],
);
const tripDefault = normalizeQueryState({
  select: tripSchema.defaultSelect,
  orderBy: [{ field: "pickup_at", dir: "desc" }],
  limit: 25,
  aggregations: [
    metric("trips", "Trips in this view", "COUNT()"),
    metric("fare", "Median total ($)", "MEDIAN([total])", [], "value", number),
    metric(
      "duration",
      "Median trip duration",
      "MEDIAN([duration_seconds])",
      [],
      "value",
      closureFormat,
    ),
    metric(
      "zones",
      "Popular pickup zones",
      "COUNT()",
      ["pickup_zone"],
      "bar-horizontal",
    ),
    {
      ...metric("fare-box", "Trip totals by borough ($)", "COUNT()", [
        "pickup_borough",
      ]),
      expression: undefined,
      display: { kind: "box", format: number },
      distribution: { kind: "box", input: "[total]", whiskers: "tukey" },
    },
    metric(
      "trip-days",
      "Trips through January",
      "COUNT()",
      ["pickup_day"],
      "line",
    ),
  ],
});
const foodSchema = schema(
  "food",
  [
    field("product", "Product", "text", "Product"),
    field("brand", "Brand", "text", "Product"),
    field("category", "Category", "text", "Product"),
    field("quantity", "Quantity", "text", "Product"),
    field("serving_size", "Serving size", "text", "Product"),
    ...[
      "categories",
      "countries",
      "labels",
      "allergens",
      "additives",
      "dietary_tags",
    ].map((name) =>
      field(
        name,
        name.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase()),
        "textarray",
        "Tags",
        { kind: "chip" },
      ),
    ),
    field("grade", "Nutri-Score", "enum", "Nutrition", {
      kind: "chip",
      labels: {
        a: "A",
        b: "B",
        c: "C",
        d: "D",
        e: "E",
        unknown: "Unknown",
        "not-applicable": "N/A",
      },
      tones: {
        a: "success",
        b: "success",
        c: "warning",
        d: "warning",
        e: "danger",
      },
    }),
    ...["sugar_g", "protein_g", "fat_g", "salt_g", "fiber_g"].map((name) =>
      field(
        name,
        `${name.split("_")[0]!.replace(/^./, (letter) => letter.toUpperCase())} (g/100g)`,
        "number",
        "Nutrition",
        number,
      ),
    ),
    field("energy_kcal", "Energy (kcal/100g)", "number", "Nutrition", number),
    field("nutrition_score", "Nutrition score", "number", "Nutrition"),
    field("processing_group", "NOVA group", "number", "Nutrition"),
    field("completeness", "Data completeness", "number", "Quality", percent),
    field("no_nutrition_data", "No nutrition data", "bool", "Quality"),
    field("obsolete", "Obsolete", "bool", "Quality"),
    field("created_at", "Added", "datetime", "Time", { kind: "datetime" }),
    field("modified_at", "Modified", "datetime", "Time", { kind: "datetime" }),
    field("ingredients_text", "Ingredient label", "text", "Details"),
    field("ingredients", "Ingredient tree", "text", "Details", json),
    field("nutrients", "Nutrient data", "text", "Details", json),
    field("packaging", "Packaging", "text", "Details", json),
    {
      ...field("product_url", "Source product", "text", "Details"),
      render: "external-link",
    },
  ],
  [
    "product",
    "brand",
    "grade",
    "sugar_g",
    "protein_g",
    "labels",
    "allergens",
    "__qt_item_details__",
  ],
);
const foodDefault = normalizeQueryState({
  select: foodSchema.defaultSelect,
  orderBy: [{ field: "completeness", dir: "desc" }],
  limit: 25,
  aggregations: [
    metric("products", "Products in this view", "COUNT()"),
    metric(
      "sugar",
      "Median sugar (g/100g)",
      "MEDIAN([sugar_g])",
      [],
      "value",
      number,
    ),
    metric(
      "coverage",
      "Sugar data available",
      "COUNT([sugar_g]) / NULLIF(COUNT(), 0)",
      [],
      "value",
      percent,
    ),
    metric("grades", "Nutri-Score distribution", "COUNT()", ["grade"], "donut"),
    {
      ...metric("sugar-hist", "How much sugar? (g/100g)", "COUNT()"),
      expression: undefined,
      display: { kind: "histogram", xFormat: number },
      distribution: { kind: "histogram", input: "[sugar_g]", bins: 15 },
    },
    metric(
      "categories",
      "Explore product categories",
      "COUNT()",
      ["category"],
      "bar-horizontal",
    ),
  ],
});
const recipe = (
  name: string,
  description: string,
  base: QueryState,
  overrides: Partial<QueryState>,
): Recipe => ({
  name,
  description,
  query: normalizeQueryState({ ...base, ...overrides }),
});
function grouped(
  base: QueryState,
  key: string,
  measure: string,
  label: string,
): QueryState {
  return normalizeQueryState({
    grouping: {
      source: base,
      keys: [key],
      summaries: [
        { id: "records", op: "count" },
        {
          id: "median",
          op: "formula",
          expression: `MEDIAN([${measure}])`,
          label,
        },
      ],
      representative: null,
    },
    select: select(key, "records", "median"),
    orderBy: [{ field: "records", dir: "desc" }],
    limit: 25,
    aggregations: [
      metric("groups", "Groups in this view", "COUNT()"),
      metric("records", "Source records", "SUM([records])"),
    ],
  });
}
export const DATASETS: Dataset[] = [
  {
    id: "311",
    title: "NYC 311",
    noun: "requests",
    color: "#47786f",
    schema: requestSchema,
    defaults: requestDefault,
    recipes: [
      recipe(
        "All requests",
        "Start with the complete demo cohort.",
        requestDefault,
        {},
      ),
      recipe(
        "Brooklyn noise",
        "Combine borough and text filters.",
        requestDefault,
        {
          where: [
            { field: "borough", op: "=", value: "BROOKLYN" },
            { field: "problem", op: "contains", value: "Noise" },
          ],
        },
      ),
      recipe(
        "Slow to close",
        "Find closed requests taking over seven days.",
        requestDefault,
        {
          where: [{ field: "closure_seconds", op: ">", value: "604800" }],
          orderBy: [{ field: "closure_seconds", dir: "desc" }],
        },
      ),
      {
        name: "Compare agencies",
        description: "Group records and compare median closure time.",
        query: grouped(
          requestDefault,
          "agency",
          "closure_seconds",
          "Median time to close (seconds)",
        ),
      },
    ],
  },
  {
    id: "trips",
    title: "NYC taxi trips",
    noun: "trips",
    color: "#ad7732",
    schema: tripSchema,
    defaults: tripDefault,
    recipes: [
      recipe("All trips", "Explore the January sample.", tripDefault, {}),
      recipe(
        "Airport pickups",
        "JFK or LaGuardia, combined with valid fares.",
        tripDefault,
        {
          where: [
            {
              any: [
                { field: "pickup_zone", op: "contains", value: "JFK" },
                { field: "pickup_zone", op: "contains", value: "LaGuardia" },
              ],
            },
            { field: "total", op: ">", value: "0" },
          ],
        },
      ),
      recipe(
        "Long & expensive",
        "Combine duration and fare thresholds.",
        tripDefault,
        {
          where: [
            { field: "duration_seconds", op: ">", value: "3600" },
            { field: "total", op: ">", value: "100" },
          ],
          orderBy: [{ field: "total", dir: "desc" }],
        },
      ),
      {
        name: "Compare neighborhoods",
        description: "Group pickup zones and compare median totals.",
        query: grouped(tripDefault, "pickup_zone", "total", "Median total ($)"),
      },
    ],
  },
  {
    id: "food",
    title: "Open Food Facts",
    noun: "products",
    color: "#957351",
    schema: foodSchema,
    defaults: foodDefault,
    recipes: [
      recipe(
        "All products",
        "Start with the named-product cohort.",
        foodDefault,
        {},
      ),
      recipe(
        "Organic labels",
        "Combine a label tag with available sugar data.",
        foodDefault,
        {
          where: [
            { field: "labels", op: "includes", value: "organic" },
            { field: "sugar_g", op: "is_not_null", value: "" },
          ],
        },
      ),
      recipe(
        "High protein",
        "At least 15g protein and less than 10g sugar per 100g.",
        foodDefault,
        {
          where: [
            { field: "protein_g", op: ">=", value: "15" },
            { field: "sugar_g", op: "<", value: "10" },
          ],
          orderBy: [{ field: "protein_g", dir: "desc" }],
        },
      ),
      {
        name: "Compare categories",
        description: "Group products and compare median sugar.",
        query: grouped(
          foodDefault,
          "category",
          "sugar_g",
          "Median sugar (g/100g)",
        ),
      },
    ],
  },
];
