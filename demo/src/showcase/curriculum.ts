import type { Dataset } from "./data";
export type ChapterId = "idea" | "table" | "query" | "metrics" | "views";
export type StepId =
  | "concept"
  | "narrow"
  | "table-sort"
  | "table-filter"
  | "resize"
  | "reorder"
  | "select"
  | "details"
  | "column"
  | "combine"
  | "formula"
  | "group"
  | "summary"
  | "having"
  | "metric"
  | "drilldown"
  | "undo"
  | "save"
  | "restore"
  | "example"
  | "share";
export interface TourChapter {
  id: ChapterId;
  title: string;
  previewTitle: string;
  description: string;
}
export interface TourStep {
  id: StepId;
  chapter: ChapterId;
  title: string;
  instruction: string;
  result: string;
  readOnly?: boolean;
  formula?: string;
}
export const CHAPTERS: TourChapter[] = [
  {
    id: "idea",
    title: "The idea",
    previewTitle: "One query, a complete view",
    description:
      "Describe a question in the query editor. The table and metrics follow. Try a simple filter to see it happen.",
  },
  {
    id: "table",
    title: "Use the table",
    previewTitle: "Work directly in the table",
    description: "Sort, filter, resize, and rearrange directly in the table.",
  },
  {
    id: "query",
    title: "Build a query",
    previewTitle: "Compose your own query",
    description:
      "Choose columns, combine conditions, calculate values, and group records in the query editor.",
  },
  {
    id: "metrics",
    title: "Explore with metrics",
    previewTitle: "Follow a question through metrics",
    description:
      "Summarize the current query, then click a chart to drill into the records behind it.",
  },
  {
    id: "views",
    title: "Save & share",
    previewTitle: "Keep a useful view",
    description:
      "Save a query to return to it, or share a link that opens the same view.",
  },
];
export function tourConfiguration(dataset: Dataset) {
  const config =
    dataset.id === "311"
      ? {
          first: "problem",
          sort: "closure_seconds",
          cell: "borough",
          column: "channel",
          group: "agency",
          combine: "status",
          either: ["Closed", "Open"],
          narrow: { field: "borough", op: "=" as const, value: "BROOKLYN" },
          formulaName: "Closure hours",
          formula:
            'IF([status] = "Closed", ROUND([closure_seconds] / 3600, 1), NULL)',
          metricName: "Typical closure hours",
          metricFormula: "MEDIAN([closure_seconds]) / 3600",
        }
      : dataset.id === "trips"
        ? {
            first: "pickup_at",
            sort: "total",
            cell: "payment",
            column: "tip_ratio",
            group: "pickup_borough",
            combine: "payment",
            either: ["Credit card", "Cash"],
            narrow: { field: "total", op: ">" as const, value: "50" },
            formulaName: "Tip percentage",
            formula: "IF([fare] > 0, ROUND(100 * [tip] / [fare], 1), NULL)",
            metricName: "Average trip total",
            metricFormula: "AVG([total])",
          }
        : {
            first: "product",
            sort: "sugar_g",
            cell: "grade",
            column: "countries",
            group: "category",
            combine: "grade",
            either: ["a", "b"],
            narrow: { field: "protein_g", op: ">" as const, value: "10" },
            formulaName: "Sugar / protein",
            formula:
              "IF([protein_g] > 0, ROUND([sugar_g] / [protein_g], 2), NULL)",
            metricName: "Average protein",
            metricFormula: "AVG([protein_g])",
          };
  const label = (name: string) =>
    dataset.schema.fields.find((f) => f.name === name)!.label;
  return { ...config, label };
}
export function curriculum(dataset: Dataset): TourStep[] {
  const c = tourConfiguration(dataset);
  return [
    {
      id: "concept",
      chapter: "idea",
      title: "One query, a complete view",
      instruction:
        "Choose columns and conditions. Query Table builds the table and metrics. The table’s controls update that same query.",
      result: "",
      readOnly: true,
    },
    {
      id: "narrow",
      chapter: "idea",
      title: "Change the question",
      instruction: `Click Add filter → ${c.label(c.narrow.field)}. Set ${c.narrow.op} ${c.narrow.value}.`,
      result:
        "The result count and records changed together. Metrics use this same filtered population.",
    },
    {
      id: "table-sort",
      chapter: "table",
      title: "Sort from a column",
      instruction: `Click the ${c.label(c.sort)} table header, then Set Sort (Desc).`,
      result:
        "The largest values moved to the top. The query now describes that same sort.",
    },
    {
      id: "table-filter",
      chapter: "table",
      title: "Filter from a value",
      instruction: `Click any ${c.label(c.cell)} cell, then choose = under keep. You can build a filter without typing its value.`,
      result:
        "The cell became a WHERE condition. The matching rows and count updated.",
    },
    {
      id: "resize",
      chapter: "table",
      title: "Make room for a column",
      instruction: `Drag the right edge of ${c.label(c.first)}. Or focus its resize handle and press Right Arrow.`,
      result:
        "The column has a new width. Layout is part of the query, so it can be saved too.",
    },
    {
      id: "reorder",
      chapter: "table",
      title: "Rearrange the view",
      instruction: `Drag the ${c.label(c.first)} table header after another column. On a touch device, use Customize columns to move it down.`,
      result: "The table and SELECT list now use the same column order.",
    },
    {
      id: "select",
      chapter: "table",
      title: "Work with selected records",
      instruction:
        "Check a row’s box. Shift-click another to select a range; the toolbar offers an export for the selected records.",
      result:
        "Selection uses record IDs, so it stays meaningful as the view changes.",
    },
    {
      id: "details",
      chapter: "table",
      title: "Look beyond the visible columns",
      instruction:
        "Open a row’s Details button. Explore its properties, then close Item details.",
      result:
        "The full record is available even when you show only a few columns.",
    },
    {
      id: "column",
      chapter: "query",
      title: "Choose your columns",
      instruction: `Click Add column → ${c.label(c.column)}.`,
      result: `${c.label(c.column)} appeared in SELECT and in the table. Different data types keep their own formatting.`,
    },
    {
      id: "combine",
      chapter: "query",
      title: "Combine alternatives with OR",
      instruction: `Add two ${c.label(c.combine)} = filters: ${c.either.join(" and ")}. Drag one onto the other to make an OR group. On mobile, open a filter and use “Match either filter (OR)”.`,
      result:
        "Either alternative now matches. Separate filter groups still combine with AND.",
    },
    {
      id: "formula",
      chapter: "query",
      title: "Calculate a new column",
      instruction: `Open Customize columns → Computed column. Name it “${c.formulaName}”, enter this formula, save the definition, then Apply columns.`,
      formula: c.formula,
      result: `${c.formulaName} now calculates a value for every row. IF handles the condition and ROUND controls precision. Missing inputs stay empty.`,
    },
    {
      id: "group",
      chapter: "query",
      title: "Turn records into groups",
      instruction: `Click Add group by → ${c.label(c.group)}.`,
      result:
        "Each row now represents a group. The source query still defines which records belong to those groups.",
    },
    {
      id: "summary",
      chapter: "query",
      title: "Add an aggregate column",
      instruction:
        "Click Add column → Row count. This counts the source records in each group.",
      result:
        "The group rows now carry counts. Aggregate columns summarize records rather than choosing one representative value.",
    },
    {
      id: "having",
      chapter: "query",
      title: "Filter the groups with HAVING",
      instruction:
        "Click Add HAVING filter, choose the row-count column, and set > 5.",
      result:
        "HAVING filters after grouping. WHERE chooses source records; HAVING chooses the resulting groups.",
    },
    {
      id: "metric",
      chapter: "metrics",
      title: "Define a measure",
      instruction: `Click Edit metrics. Change the first metric’s name to “${c.metricName}” and its formula to the expression below, then Apply metrics.`,
      formula: c.metricFormula,
      result:
        "The metric is evaluated over the whole matching population, including records beyond the current page.",
    },
    {
      id: "drilldown",
      chapter: "metrics",
      title: "Ask the next question in a chart",
      instruction:
        "Click a category in a bar or ring chart. The chart category becomes a filter.",
      result:
        "The chart added a real WHERE condition. The table, result count, and other metrics all follow it.",
    },
    {
      id: "undo",
      chapter: "metrics",
      title: "Explore without losing your place",
      instruction:
        "Click Undo in the query toolbar to step back from the chart filter.",
      result:
        "The previous query and population returned. You can keep exploring or use Redo to return to the drilldown.",
    },
    {
      id: "save",
      chapter: "views",
      title: "Keep a useful view",
      instruction:
        "Click Save query, name the view, and press Save view. Filters, columns, widths, sorting, and metrics stay together.",
      result:
        "Your named view is now under Yours. It is stored in this browser.",
    },
    {
      id: "restore",
      chapter: "views",
      title: "Return to your view",
      instruction: `Load “${dataset.recipes[0]!.name}” to switch away, then click your saved view under Yours.`,
      result: "Loading the view restored its complete query and layout.",
    },
    {
      id: "example",
      chapter: "views",
      title: "Learn from a saved example",
      instruction: `Load “${dataset.recipes[3]!.name}” under Examples. Inspect its grouped columns and metrics.`,
      result:
        "Examples are complete saved queries too. You can modify one and save your own copy.",
    },
    {
      id: "share",
      chapter: "views",
      title: "Share the complete question",
      instruction:
        "Click Share in the query toolbar. Copy the link or use your device’s share sheet.",
      result:
        "The link carries this view’s query, grouping, layout, and metrics. A new browser can open the same view.",
    },
  ];
}
