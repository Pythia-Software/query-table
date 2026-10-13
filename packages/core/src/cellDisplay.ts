/** Presentation hints only: field types still determine query/filter semantics. */
export interface JsonCellDisplay {
  kind: "json";
  /** auto accepts objects, JSON text and repeatedly encoded/escaped JSON text.
   * value keeps a native string literal; json parses text once; escaped unwraps it. */
  encoding?: "auto" | "value" | "json" | "escaped";
  /** Maximum string-unwrapping passes, 1–8. Default 4. */
  maxDecodeDepth?: number;
  /** Inline preview length, 20–500 characters. Default 80. */
  previewLength?: number;
  /** Override initially expanded container levels, 0–8.
   * The root starts open. By default, nested containers with up to 3 entries
   * open; larger nested containers collapse. */
  expandDepth?: number;
}

type CalendarDisplay = {
  style?: "human" | "iso" | "custom";
  pattern?: string;
  /** UTC by default; an IANA timezone or local may be selected explicitly. */
  timeZone?: string;
  locale?: string;
};

export type CellDisplay =
  | JsonCellDisplay
  | ({ kind: "date" | "datetime"; sourceUnit?: "iso" | "epochSeconds" | "epochMilliseconds" } & CalendarDisplay)
  | ({ kind: "time"; sourceUnit?: "iso" | "epochSeconds" | "epochMilliseconds" | "secondsOfDay" | "millisecondsOfDay" } & CalendarDisplay)
  | { kind: "duration"; sourceUnit?: "milliseconds" | "seconds" | "minutes" | "hours" | "days"; style?: "human" | "long" | "clock" | "custom"; pattern?: string; decimals?: number }
  | { kind: "number" | "percent"; decimals?: number; locale?: string }
  | { kind: "chip"; labels?: Record<string, string>; tones?: Record<string, "neutral" | "success" | "warning" | "danger"> }
  | { kind: "text"; truncate?: boolean };

const calendarOptions = {
  style: ["human", "iso", "custom"], pattern: "string", timeZone: "string", locale: "string",
} as const;
const numberOptions = { decimals: [0, 20], locale: "string" } as const;
const calendarUnits = ["iso", "epochSeconds", "epochMilliseconds"];
const options: Record<string, Record<string, readonly string[] | readonly number[] | string>> = {
  json: { encoding: ["auto", "value", "json", "escaped"], maxDecodeDepth: [1, 8], previewLength: [20, 500], expandDepth: [0, 8] },
  date: { ...calendarOptions, sourceUnit: calendarUnits },
  datetime: { ...calendarOptions, sourceUnit: calendarUnits },
  time: { ...calendarOptions, sourceUnit: [...calendarUnits, "secondsOfDay", "millisecondsOfDay"] },
  duration: { sourceUnit: ["milliseconds", "seconds", "minutes", "hours", "days"], style: ["human", "long", "clock", "custom"], pattern: "string", decimals: [0, 20] },
  number: numberOptions, percent: numberOptions,
  chip: { labels: "labels", tones: "tones" },
  text: { truncate: "boolean" },
};

/** Validate the serializable contract at schema loading, before rendering cells. */
export function parseCellDisplay(raw: unknown, context = "cell display"): CellDisplay {
  const fail = (reason: string): never => { throw Error(`${context}: ${reason}`); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("expected an object");
  const record = raw as Record<string, unknown>;
  if (typeof record.kind !== "string" || !Object.prototype.hasOwnProperty.call(options, record.kind)) return fail("unsupported kind");
  const allowed = options[record.kind]!;
  for (const [key, value] of Object.entries(record)) {
    if (key === "kind") continue;
    const rule = Object.prototype.hasOwnProperty.call(allowed, key) ? allowed[key] : undefined;
    if (!rule) return fail(`unsupported option ${key}`);
    if (Array.isArray(rule)) {
      if (typeof rule[0] === "number") {
        if (typeof value !== "number" || !Number.isInteger(value) || value < Number(rule[0]) || value > Number(rule[1])) return fail(`${key} must be an integer from ${rule[0]} to ${rule[1]}`);
      } else if (!rule.includes(value as never)) return fail(`unsupported ${key}`);
    } else if (rule === "labels" || rule === "tones") {
      if (!value || typeof value !== "object" || Array.isArray(value) || !Object.values(value).every((item) => typeof item === "string" && (rule === "labels" || ["neutral", "success", "warning", "danger"].includes(item)))) return fail(`invalid ${key} map`);
    } else if (typeof value !== rule) return fail(`${key} must be ${rule}`);
    if (key === "pattern" && (value as string).length > 160) return fail("pattern must be at most 160 characters");
  }
  return { ...record,
    ...(record.labels ? { labels: { ...record.labels as Record<string, string> } } : {}),
    ...(record.tones ? { tones: { ...record.tones as Record<string, string> } } : {}),
  } as CellDisplay;
}
