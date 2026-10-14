import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  computedFieldName,
  predicatesOf,
  readFieldValue,
  type QueryState,
  type SavedQuery,
} from "@pythia-software/query-table-core";
import type { QueryTableApi } from "@pythia-software/query-table-react";
import { Icon } from "@pythia-software/query-table-ui";
import type { Dataset } from "./data";
import { exampleQueryId } from "./storage";
import {
  CHAPTERS,
  curriculum,
  tourConfiguration,
  type StepId,
  type ChapterId,
  type TourStep,
} from "./curriculum";
interface Session {
  index: number;
  preview: boolean;
  done: Partial<Record<StepId, boolean>>;
  baseline: QueryState;
  columns: string[];
  widths: Record<string, number | undefined>;
  selectionCount: number;
  savedId: string | null;
  savedName: string | null;
  leftSavedView: boolean;
  sawDetails: boolean;
}
interface TourHost {
  ready: boolean;
  revisions: Record<string, string>;
  load(id: string): Promise<void>;
  save(name: string): Promise<SavedQuery>;
  prepare(chapter: ChapterId): void;
}
export type TourEvent =
  | { type: "load"; id: string }
  | { type: "saved"; saved: SavedQuery }
  | { type: "inspect" }
  | { type: "share" };
const dom = (selector: string) =>
  document.querySelector<HTMLElement>(selector) ?? undefined;
const button = (name: string, root: ParentNode = document) =>
  [
    ...root.querySelectorAll<HTMLElement>(
      "button,[role=button],[role=menuitem]",
    ),
  ].find(
    (e) => (e.getAttribute("aria-label") ?? e.textContent?.trim()) === name,
  );
const savedButton = (id: string | null) =>
  id ? dom(`[data-saved-id="${CSS.escape(id)}"]`) : undefined;
const header = (field: string) =>
  dom(`.showcase-table th[data-qt-field="${CSS.escape(field)}"]`);
const cell = (field: string) =>
  [
    ...document.querySelectorAll<HTMLElement>(
      `.showcase-table .qt-row [data-qt-field="${CSS.escape(field)}"]`,
    ),
  ].find((e) => e.textContent?.trim() && e.textContent.trim() !== "—");
const picker = (label: string) => {
  const item = [
    ...document.querySelectorAll<HTMLElement>(".qt-picker-item"),
  ].find((e) => e.querySelector(".qt-picker-label")?.textContent === label);
  return item &&
    visibleRect(item, { x: 0, y: 0, width: innerWidth, height: innerHeight })
    ? item
    : dom('[aria-label="Search fields"]');
};
function reveal(element: HTMLElement | undefined, focus = false) {
  if (!element) return;
  element.scrollIntoView({
    block: "center",
    inline: "center",
    behavior:
      focus && !matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "smooth"
        : "instant",
  });
  if (focus) element.focus({ preventScroll: true });
}
function waitFor(check: () => boolean, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const poll = () => {
      if (signal.aborted) {
        reject(new DOMException("Tour ended", "AbortError"));
        return;
      }
      if (check()) {
        resolve();
        return;
      }
      if (performance.now() - start > 15000) {
        reject(Error("The action is still waiting for results. Try again."));
        return;
      }
      setTimeout(poll, 40);
    };
    poll();
  });
}
export function useGuidedTour<Row>(
  api: QueryTableApi<Row>,
  dataset: Dataset,
  host: TourHost,
) {
  const config = useMemo(() => tourConfiguration(dataset), [dataset]);
  const steps = useMemo(() => curriculum(dataset), [dataset]);
  const [session, setSession] = useState<Session | null>(null),
    [finished, setFinished] = useState(false),
    [uiVersion, setUiVersion] = useState(0);
  const [running, setRunning] = useState(false),
    [actionError, setActionError] = useState<string | null>(null),
    [settling, setSettling] = useState(false);
  const action = useRef<AbortController | null>(null);
  const current = useRef({ api, host, session });
  current.current = { api, host, session };
  const lesson = session ? steps[session.index]! : null;
  const chapter = lesson ? CHAPTERS.find((c) => c.id === lesson.chapter)! : null;
  const preview = !!session?.preview;
  const step: TourStep | null = preview && lesson && chapter
    ? {
        id: lesson.id,
        chapter: lesson.chapter,
        title: chapter.previewTitle,
        instruction: chapter.description,
        result: "",
        readOnly: true,
      }
    : lesson;
  const complete = !!(step?.readOnly || (step && session?.done[step.id]));
  const modalOpen = !!document.querySelector("[role=dialog][aria-modal=true]");
  const busy =
    api.loading ||
    api.aggregations.loading ||
    !api.restoration.ready ||
    !host.ready ||
    settling;
  useEffect(() => {
    if (!session) return;
    setSettling(true);
    const timer = setTimeout(() => setSettling(false), 240);
    return () => clearTimeout(timer);
  }, [api.query, host.ready, !!session]);
  useEffect(() => () => action.current?.abort(), []);
  const mark = useCallback(
    (id: StepId) =>
      setSession((s) =>
        s && !s.preview && steps[s.index]?.id === id && !s.done[id]
          ? { ...s, done: { ...s.done, [id]: true } }
          : s,
      ),
    [steps],
  );
  const record = useCallback(
    (event: TourEvent) => {
      setSession((s) => {
        if (!s || s.preview) return s;
        const id = steps[s.index]!.id;
        let next = { ...s },
          done = false;
        if (event.type === "load") {
          if (id === "example")
            done = event.id === exampleQueryId(dataset.id, 3);
          if (id === "restore") {
            if (event.id !== s.savedId) next.leftSavedView = true;
            done = next.leftSavedView && event.id === s.savedId;
          }
        }
        if (event.type === "saved" && id === "save") {
          done = true;
          next.savedId = event.saved.id;
          next.savedName = event.saved.name;
        }
        if (event.type === "inspect" && id === "drilldown") done = true;
        if (event.type === "share" && id === "share") done = true;
        if (done) next.done = { ...s.done, [id]: true };
        return done || next.leftSavedView !== s.leftSavedView ? next : s;
      });
    },
    [steps, dataset.id],
  );
  useEffect(() => {
    if (!step || !session || complete) return;
    const terms = api.query.where.flatMap(predicatesOf);
    let done = false;
    switch (step.id) {
      case "narrow":
        done = terms.some(
          (p) =>
            p.field === config.narrow.field &&
            p.op === config.narrow.op &&
            p.value === config.narrow.value &&
            !p.negated,
        );
        break;
      case "table-sort":
        done =
          api.query.orderBy[0]?.field === config.sort &&
          api.query.orderBy[0]?.dir === "desc";
        break;
      case "table-filter":
        done = terms.some(
          (p) =>
            p.field === config.cell &&
            !session.baseline.where
              .flatMap(predicatesOf)
              .some((old) => JSON.stringify(old) === JSON.stringify(p)),
        );
        break;
      case "resize":
        done = api.query.select.some(
          (c) =>
            c.field === config.first &&
            c.width !== undefined &&
            c.width !== session.widths[config.first],
        );
        break;
      case "reorder":
        done =
          api.select.visible.findIndex((c) => c.field === config.first) !==
          session.columns.indexOf(config.first);
        break;
      case "select":
        done = api.selection.count > session.selectionCount;
        break;
      case "details":
        if (
          api.itemDetails?.active &&
          api.itemDetails.record &&
          !api.itemDetails.loading &&
          !session.sawDetails
        ) {
          setSession((s) => (s ? { ...s, sawDetails: true } : s));
          return;
        }
        done = session.sawDetails && !api.itemDetails?.active;
        break;
      case "column":
        done = api.select.visible.some((c) => c.field === config.column);
        break;
      case "combine":
        done = api.query.where.some(
          (term) =>
            "any" in term &&
            config.either.every((value) =>
              term.any.some(
                (p) =>
                  p.field === config.combine &&
                  p.op === "=" &&
                  p.value === value &&
                  !p.negated,
              ),
            ),
        );
        break;
      case "formula":
        done = api.computed.definitions.some(
          (def) =>
            def.expression.source.replace(/\s/g, "") ===
              config.formula.replace(/\s/g, "") &&
            api.select.visible.some(
              (col) => col.field === computedFieldName(def.id),
            ),
        );
        break;
      case "group":
        done = !!api.query.grouping?.keys.includes(config.group);
        break;
      case "summary":
        done = !!api.query.grouping?.summaries.some(
          (s) =>
            s.op === "count" &&
            !s.field &&
            api.select.visible.some((c) => c.field === s.id),
        );
        break;
      case "having":
        done = terms.some(
          (p) =>
            p.field ===
              api.query.grouping?.summaries.find(
                (s) => s.op === "count" && !s.field,
              )?.id &&
            p.op === ">" &&
            p.value === "5",
        );
        break;
      case "metric":
        done = !!api.query.aggregations?.some(
          (m) =>
            m.label === config.metricName &&
            m.expression?.replace(/\s/g, "") ===
              config.metricFormula.replace(/\s/g, ""),
        );
        break;
      case "undo":
        done =
          api.canRedo &&
          JSON.stringify(api.query.where) !==
            JSON.stringify(session.baseline.where);
        break;
      default:
        break;
    }
    if (done) mark(step.id);
  }, [
    step,
    session,
    complete,
    api.query,
    api.select.visible,
    api.selection.count,
    api.computed.definitions,
    api.itemDetails,
    api.canRedo,
    config,
    mark,
    uiVersion,
  ]);
  useEffect(() => {
    if (!session) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          setUiVersion((v) => v + 1);
        });
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-expanded", "aria-label", "disabled", "value"],
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [!!session]);
  function results(): HTMLElement[] {
    if (!step) return [];
    if (preview && chapter?.id !== "idea") return [];
    const count = dom(".showcase-table .showcase-section-heading");
    const where = dom('.showcase-query [data-clause="where"]');
    const columns = dom(".showcase-query .qt-qb-row--select");
    const sort = dom(".showcase-query .qt-qb-row--sort");
    let list: (HTMLElement | undefined)[] = [];
    switch (step.id) {
      case "concept":
        list = [dom('.showcase-query [data-mobile-label="Columns"]'), count];
        break;
      case "narrow":
      case "table-filter":
      case "combine":
      case "drilldown":
      case "undo":
        list = [count, where];
        break;
      case "table-sort":
        list = [header(config.sort), sort];
        break;
      case "resize":
      case "reorder":
        list = [header(config.first), columns];
        break;
      case "column":
        list = [header(config.column), columns];
        break;
      case "formula": {
        const def = api.computed.definitions.find(
          (d) =>
            d.expression.source.replace(/\s/g, "") ===
            config.formula.replace(/\s/g, ""),
        );
        list = [def ? header(computedFieldName(def.id)) : undefined, columns];
        break;
      }
      case "select":
        list = [dom(".qt-selection-toolbar"), dom(".qt-row--selected")];
        break;
      case "details":
        list = [dom(".showcase-table .qt-row")];
        break;
      case "group":
      case "summary":
      case "having":
      case "example":
        list = [
          count,
          dom('.showcase-query [aria-label="Grouping and HAVING"]'),
        ];
        break;
      case "metric":
        list = [dom(".showcase-metrics .qt-metric")];
        break;
      case "save":
      case "restore":
        list = [
          savedButton(session?.savedId ?? null),
          dom(".showcase-current-view"),
        ];
        break;
      case "share":
        list = [button("Copied!"), button("Share")];
        break;
    }
    return list
      .filter((e): e is HTMLElement => !!e)
      .filter((e, i, list) => list.indexOf(e) === i);
  }
  function previewRegion(): HTMLElement | undefined {
    if (!preview || !chapter || chapter.id === "idea") return;
    const selectors: Record<Exclude<ChapterId, "idea">, string> = {
      table: ".showcase-table",
      query: ".showcase-query",
      metrics: ".showcase-metrics",
      views: ".showcase-saved",
    };
    return dom(selectors[chapter.id]);
  }
  function locate(): HTMLElement | undefined {
    if (!step || !session) return;
    if (preview && chapter) {
      switch (chapter.id) {
        case "idea":
          return dom('.showcase-query [data-mobile-label="Columns"]') ?? dom(".showcase-query");
        case "table":
          return dom(".showcase-table thead") ?? dom(".showcase-table .showcase-section-heading");
        case "query":
          return dom('.showcase-query [data-mobile-label="Columns"]') ?? dom(".showcase-query");
        case "metrics":
          return dom(".showcase-metrics .showcase-section-heading");
        case "views":
          return dom(".showcase-sidebar-heading");
      }
    }
    const editor = dom(".showcase-query") ?? document;
    if (complete && !modalOpen) return results()[0];
    switch (step.id) {
      case "concept":
        return dom(".showcase-query");
      case "narrow":
        return (
          (config.narrow.op === ">" ? button(">") : undefined) ??
          dom(
            `[aria-label="Value for ${config.label(config.narrow.field)}"]`,
          ) ??
          picker(config.label(config.narrow.field)) ??
          button("Add filter", editor)
        );
      case "table-sort":
        return button("Set Sort (Desc)") ?? header(config.sort);
      case "table-filter":
        return (
          dom(".qt-cm-filter:not(.qt-cm-filter--neg)") ?? cell(config.cell)
        );
      case "resize":
        return dom(
          `[aria-label="Resize ${config.label(config.first)} column"]`,
        );
      case "reorder":
        if (modalOpen) {
          const handle =
            dom(
              `[aria-label="Drag to reorder ${config.label(config.first)}"]`,
            ) ?? dom(`[aria-label="Move ${config.label(config.first)} down"]`);
          if (
            handle &&
            visibleRect(handle, {
              x: 0,
              y: 0,
              width: innerWidth,
              height: innerHeight,
            })
          )
            return handle;
          return (
            button(`Selected (${api.select.visible.length})`) ??
            button("Apply columns")
          );
        }
        return header(config.first);
      case "select":
        return dom(".qt-row input[type=checkbox]");
      case "details":
        return (
          button("Close item details") ?? dom(".qt-item-detail-column button")
        );
      case "column":
        return (
          picker(config.label(config.column)) ?? button("Add column", editor)
        );
      case "combine":
        return (
          dom(".qt-filter-combine select") ??
          dom(`[aria-label="Value for ${config.label(config.combine)}"]`) ??
          picker(config.label(config.combine)) ??
          button("Add filter", editor)
        );
      case "formula":
        return dom('[aria-label="Computed column formula"]')
          ? button("Save shared definition")
            ? button("Apply columns")
            : dom('[aria-label="Computed column formula"]')
          : (button("Computed column") ?? button("Customize columns", editor));
      case "group":
        return (
          picker(config.label(config.group)) ?? button("Add group by", editor)
        );
      case "summary":
        return picker("Row count") ?? button("Add column", editor);
      case "having": {
        const field = api.query.grouping?.summaries.find(
          (s) => s.op === "count" && !s.field,
        )?.id;
        const label = api.schema?.fields.find((f) => f.name === field)?.label;
        return label
          ? (button(">") ??
              dom(`[aria-label="Value for ${label}"]`) ??
              picker(label) ??
              button("Add HAVING filter", editor))
          : button("Add HAVING filter", editor);
      }
      case "metric":
        return (
          dom('[aria-label="Metric expression"]') ??
          dom('[aria-label="Metric name"]') ??
          button("Edit metrics")
        );
      case "drilldown":
        return dom(".showcase-metrics .qt-metric-chart-layout [role=button]");
      case "undo":
        return button("Undo", editor);
      case "save":
        return dom("#showcase-query-name") ?? button("Save query", editor);
      case "restore":
        return savedButton(
          session.leftSavedView
            ? session.savedId
            : exampleQueryId(dataset.id, 0),
        );
      case "example":
        return savedButton(exampleQueryId(dataset.id, 3));
      case "share":
        return button("Share", editor) ?? button("Copied!", editor);
    }
  }
  const locateRef = useRef(locate),
    resultsRef = useRef(results),
    regionRef = useRef(previewRegion);
  locateRef.current = locate;
  resultsRef.current = results;
  regionRef.current = previewRegion;
  useEffect(() => {
    const target = locateRef.current();
    if (!target) return;
    target.classList.add("showcase-tour-target");
    const previous = target.getAttribute("aria-describedby");
    target.setAttribute(
      "aria-describedby",
      `${previous ? previous + " " : ""}showcase-tour-instruction`,
    );
    return () => {
      target.classList.remove("showcase-tour-target");
      if (previous === null) target.removeAttribute("aria-describedby");
      else target.setAttribute("aria-describedby", previous);
    };
  }, [step?.id, preview, complete, uiVersion, session?.leftSavedView]);
  const showTarget = useCallback(() => reveal(locateRef.current(), true), []);
  useEffect(() => {
    if (!step) return;
    const frame = requestAnimationFrame(() => {
      const target = locateRef.current();
      if (!target) return;
      const bounds = target.getBoundingClientRect(),
        visible = visibleRect(target, {
          x: 0,
          y: 0,
          width: innerWidth,
          height: innerHeight,
        });
      if (
        bounds.top < 32 ||
        bounds.bottom > innerHeight - 32 ||
        !visible ||
        visible.width < bounds.width - 1 ||
        visible.height < bounds.height - 1
      )
        reveal(target);
    });
    return () => cancelAnimationFrame(frame);
  }, [step?.id, preview, complete]);
  function baseline(
    index: number,
    old: Session | null = null,
    query = api.query,
  ): Session {
    return {
      index,
      preview: false,
      done: old?.done ?? {},
      baseline: JSON.parse(JSON.stringify(query)) as QueryState,
      columns: api.select.visible.map((c) => c.field),
      widths: Object.fromEntries(
        api.select.visible.map((c) => [
          c.field,
          c.width ??
            api.visibleFields.find((f) => f.name === c.field)?.select?.width,
        ]),
      ),
      selectionCount: api.selection.count,
      savedId: old?.savedId ?? null,
      savedName: old?.savedName ?? null,
      leftSavedView: false,
      sawDetails: false,
    };
  }
  function stopAction() {
    action.current?.abort();
    setRunning(false);
    setActionError(null);
  }
  function goChapter(id: ChapterId) {
    if (modalOpen || running) return;
    stopAction();
    const next = baseline(steps.findIndex((s) => s.chapter === id), session);
    next.preview = true;
    setSession(next);
    setFinished(false);
  }
  function learnMore() {
    if (!session || !preview || !chapter || busy || modalOpen || running) return;
    const id = chapter.id;
    stopAction();
    host.prepare(id);
    const chapterQuery =
      id === "views"
        ? dataset.recipes[dataset.id === "food" ? 2 : 1]!.query
        : dataset.defaults;
    const next = baseline(
      steps.findIndex((s) => s.chapter === id) + (id === "idea" ? 1 : 0),
      session,
      chapterQuery,
    );
    next.columns = chapterQuery.select.map((c) => c.field);
    next.widths = Object.fromEntries(
      chapterQuery.select.map((c) => [
        c.field,
        c.width ??
          dataset.schema.fields.find((f) => f.name === c.field)?.select?.width,
      ]),
    );
    next.selectionCount = 0;
    next.done = { ...next.done };
    for (const s of steps.filter((s) => s.chapter === id))
      delete next.done[s.id];
    setSession(next);
    setFinished(false);
  }
  function next() {
    if (!session || !complete || busy || modalOpen || running) return;
    if (preview) {
      learnMore();
      return;
    }
    if (session.index === steps.length - 1) {
      stopAction();
      setSession(null);
      setFinished(true);
      return;
    }
    const upcoming = steps[session.index + 1]!;
    if (upcoming.chapter !== step?.chapter) {
      goChapter(upcoming.chapter);
      return;
    }
    setSession(baseline(session.index + 1, session));
    setActionError(null);
  }
  async function doIt() {
    if (!step || !session || step.readOnly || running || busy) return;
    const id = step.id,
      ac = new AbortController();
    action.current?.abort();
    action.current = ac;
    setRunning(true);
    setActionError(null);
    const live = () => current.current.api;
    try {
      // If a native editor is open, finish through its close control before
      // applying the same controller intent. Never leave a stale draft open.
      if (modalOpen && id !== "details") {
        const close =
          document.querySelector<HTMLElement>(
            '[role=dialog] button[aria-label^="Close"]',
          ) ??
          button("Cancel layout changes") ??
          button("Cancel");
        if (!close)
          throw Error("Close the editor first, then use Do it for me.");
        close.click();
        await waitFor(
          () => !document.querySelector("[role=dialog][aria-modal=true]"),
          ac.signal,
        );
      }
      ac.signal.throwIfAborted();
      switch (id) {
        case "narrow":
          live().addFilter({ ...config.narrow });
          break;
        case "table-sort":
          live().setSort([{ field: config.sort, dir: "desc" }]);
          break;
        case "table-filter": {
          const field = dataset.schema.fields.find(
            (f) => f.name === config.cell,
          )!;
          const value = live()
            .rows.map((row) => readFieldValue(field, row))
            .find((v) => v !== null && v !== undefined && v !== "");
          live().addFilter({
            field: config.cell,
            op: value == null ? "is_null" : "=",
            value: value == null ? "" : String(value),
          });
          break;
        }
        case "resize":
          live().select.setWidth(
            config.first,
            (session.widths[config.first] ?? 180) + 48,
          );
          break;
        case "reorder":
          live().select.move(
            config.first,
            session.columns.indexOf(config.first) === 0 ? 1 : 0,
          );
          break;
        case "select": {
          const row = live().rows[0];
          if (!row) throw Error("Wait for a record to load.");
          const id = live().rowId(row);
          if (id === null) throw Error("This record has no identity.");
          live().selection.replace([id]);
          break;
        }
        case "details": {
          const details = live().itemDetails!;
          if (details.active) {
            details.close();
            break;
          }
          const row = live().rows[0];
          if (!row) throw Error("Wait for a record to load.");
          const rowId = live().rowId(row);
          if (rowId === null) throw Error("This record has no identity.");
          details.open(rowId, "modal");
          await waitFor(
            () => !!live().itemDetails?.record && !live().itemDetails?.loading,
            ac.signal,
          );
          await new Promise((resolve) => setTimeout(resolve, 900));
          ac.signal.throwIfAborted();
          live().itemDetails!.close();
          break;
        }
        case "column":
          live().select.show(config.column);
          break;
        case "combine":
          live().setQuery((q) => ({
            ...q,
            offset: 0,
            where: [
              ...q.where.filter(
                (t) => !predicatesOf(t).some((p) => p.field === config.combine),
              ),
              {
                any: config.either.map((value) => ({
                  field: config.combine,
                  op: "=" as const,
                  value,
                })),
              },
            ],
          }));
          break;
        case "formula": {
          const formulaId = `tour-${dataset.id}-formula`,
            existing = live().computed.definitions.find(
              (d) => d.id === formulaId,
            );
          const def = await live().computed.save(
            {
              id: formulaId,
              label: config.formulaName,
              expression: {
                language: "qt-expr",
                version: 1,
                source: config.formula,
              },
            },
            existing?.revision ?? null,
          );
          await waitFor(
            () =>
              current.current.host.ready &&
              current.current.host.revisions[def.id] === def.revision &&
              live().computed.definitions.some(
                (d) => d.id === def.id && d.revision === def.revision,
              ),
            ac.signal,
          );
          ac.signal.throwIfAborted();
          live().select.show(computedFieldName(def.id));
          break;
        }
        case "group":
          live().grouping!.changeKeys([config.group]);
          break;
        case "summary":
          live().grouping!.addSummary("count");
          break;
        case "having": {
          const count = live().query.grouping?.summaries.find(
            (s) => s.op === "count" && !s.field,
          );
          if (!count) throw Error("Add the row-count column first.");
          live().addFilter({ field: count.id, op: ">", value: "5" });
          break;
        }
        case "metric": {
          const first = live().aggregations.clauses[0];
          if (!first) throw Error("Add a metric first.");
          live().aggregations.update(first.id, {
            label: config.metricName,
            expression: config.metricFormula,
            display: { kind: "value", format: { kind: "number", decimals: 2 } },
          });
          break;
        }
        case "drilldown": {
          const mark = dom(
            ".showcase-metrics .qt-metric-chart-layout [role=button]",
          );
          if (!mark) throw Error("Wait for the chart to load.");
          mark.dispatchEvent(
            new MouseEvent("click", { bubbles: true, view: window }),
          );
          break;
        }
        case "undo":
          live().undo();
          break;
        case "save":
          await current.current.host.save(`My ${dataset.title} view`);
          break;
        case "restore":
          if (!session.savedId) throw Error("Save your view first.");
          await current.current.host.load(exampleQueryId(dataset.id, 0));
          await new Promise((resolve) => setTimeout(resolve, 600));
          ac.signal.throwIfAborted();
          await current.current.host.load(session.savedId);
          break;
        case "example":
          await current.current.host.load(exampleQueryId(dataset.id, 3));
          break;
        case "share": {
          const share = button("Share", dom(".showcase-query") ?? document);
          if (!share) throw Error("Wait for Share to become available.");
          share.click();
          break;
        }
      }
    } catch (error) {
      if (!ac.signal.aborted)
        setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (action.current === ac) setRunning(false);
    }
  }
  const chapterIndex = chapter ? CHAPTERS.indexOf(chapter) : 0;
  const chapterSteps = steps.filter((s) => s.chapter === chapter?.id);
  return {
    active: !!session,
    finished,
    step,
    preview,
    chapter,
    chapters: CHAPTERS,
    chapterIndex,
    chapterLesson: step && !preview
      ? chapterSteps.findIndex((s) => s.id === step.id) + 1
      : 0,
    chapterCount: chapterSteps.length,
    index: session?.index ?? 0,
    count: steps.length,
    complete,
    modalOpen,
    running,
    actionError,
    canAdvance: complete && !busy && !modalOpen && !running,
    blocked: busy || running,
    canChoose: !modalOpen && !running,
    start() {
      stopAction();
      setFinished(false);
      setSession({ ...baseline(0), preview: true });
    },
    end() {
      stopAction();
      setSession(null);
    },
    next,
    goChapter,
    nextChapter() {
      const next = CHAPTERS[chapterIndex + 1];
      if (next) goChapter(next.id);
      else {
        stopAction();
        setSession(null);
        if (preview) setFinished(true);
      }
    },
    back() {
      if (!session || modalOpen || running || (!preview && busy))
        return;
      if (preview) {
        const previous = CHAPTERS[chapterIndex - 1];
        if (previous) goChapter(previous.id);
        return;
      }
      const first = steps.findIndex((s) => s.chapter === chapter?.id);
      if (session.index === first || steps[session.index - 1]?.id === "concept") {
        stopAction();
        setSession({ ...baseline(first, session), preview: true });
        return;
      }
      const previous = steps[session.index - 1]!;
      if (previous.chapter !== step?.chapter) goChapter(previous.chapter);
      else setSession(baseline(session.index - 1, session));
    },
    doIt,
    showTarget,
    record,
    locateTarget: useCallback(() => locateRef.current(), []),
    locateResults: useCallback(() => resultsRef.current(), []),
    locateRegion: useCallback(() => regionRef.current(), []),
    savedName: session?.savedName ?? null,
  };
}
export type GuidedTourApi = ReturnType<typeof useGuidedTour>;

interface TourRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface TourLayout {
  viewport: TourRect;
  target: TourRect | null;
  highlights: TourRect[];
  cutouts: TourRect[];
  card: TourRect;
  arrows: string[];
  theme: "light" | "dark";
}
type TourPoint = Pick<TourRect, "x" | "y">;
type PositionScope = "page" | "editor";
interface CardDrag {
  pointerId: number;
  start: TourPoint;
  origin: TourPoint;
  scope: PositionScope;
}
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(value, Math.max(min, max)));
const center = (rect: TourRect) => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
});
const overlap = (a: TourRect, b: TourRect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

// Intersect with scroll containers too: a picker item can exist outside its
// menu's visible area. A spotlight must never expose an unrelated control.
function visibleRect(element: Element, viewport: TourRect): TourRect | null {
  const bounds = element.getBoundingClientRect();
  let left = Math.max(bounds.left, viewport.x),
    top = Math.max(bounds.top, viewport.y),
    right = Math.min(bounds.right, viewport.x + viewport.width),
    bottom = Math.min(bounds.bottom, viewport.y + viewport.height);
  for (
    let parent =
      getComputedStyle(element).position === "fixed"
        ? null
        : element.parentElement;
    parent && parent !== document.body && parent !== document.documentElement;
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent),
      rect = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      left = Math.max(left, rect.left);
      right = Math.min(right, rect.right);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
    }
    // Fixed backdrops can live inside a scrolling dashboard in the DOM while
    // rendering in the viewport; its scroll container does not clip them.
    if (style.position === "fixed") break;
  }
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}
const padded = (rect: TourRect, amount: number): TourRect => ({
  x: rect.x - amount,
  y: rect.y - amount,
  width: rect.width + amount * 2,
  height: rect.height + amount * 2,
});
const viewportRect = (): TourRect => {
  const visual = window.visualViewport;
  return {
    x: visual?.offsetLeft ?? 0,
    y: visual?.offsetTop ?? 0,
    width: visual?.width ?? innerWidth,
    height: visual?.height ?? innerHeight,
  };
};
const fitCard = (
  viewport: TourRect,
  width: number,
  height: number,
  point: TourPoint,
): TourRect => ({
  x: clamp(point.x, viewport.x + 12, viewport.x + viewport.width - width - 12),
  y: clamp(point.y, viewport.y + 12, viewport.y + viewport.height - height - 12),
  width,
  height,
});

function placeCard(
  viewport: TourRect,
  width: number,
  height: number,
  target: TourRect | null,
  cutout: TourRect | null,
  modal: boolean,
  avoid: TourRect[] = [],
): TourRect {
  const margin = 12,
    gap = 36;
  const fit = (x: number, y: number) =>
    fitCard(viewport, width, height, { x, y });
  if (modal || !target || !cutout)
    return fit(viewport.x + (viewport.width - width) / 2, viewport.y + margin);
  const anchor = center(target);
  const candidates = [
    fit(cutout.x + cutout.width + gap, anchor.y - height / 2),
    fit(cutout.x - width - gap, anchor.y - height / 2),
    fit(anchor.x - width / 2, cutout.y + cutout.height + gap),
    fit(anchor.x - width / 2, cutout.y - height - gap),
  ];
  if (avoid.length) {
    const bottom = Math.max(...avoid.map((r) => r.y + r.height)),
      top = Math.min(...avoid.map((r) => r.y));
    candidates.push(
      fit(anchor.x - width / 2, bottom + gap),
      fit(anchor.x - width / 2, top - height - gap),
    );
  }
  const score = (rect: TourRect) => {
    const point = center(rect);
    return (
      [cutout, target, ...avoid].reduce(
        (sum, r) => sum + overlap(rect, padded(r, 14)),
        0,
      ) *
        1000 +
      Math.hypot(point.x - anchor.x, point.y - anchor.y)
    );
  };
  return candidates.sort((a, b) => score(a) - score(b))[0]!;
}

// Follow the facing edges as the card moves. Spread the origins slightly so
// arrows to vertically aligned results remain individually visible.
function edgePoint(rect: TourRect, toward: TourPoint, padding = 0) {
  const a = center(rect),
    dx = toward.x - a.x,
    dy = toward.y - a.y;
  if (Math.abs(dx) / rect.width > Math.abs(dy) / rect.height) {
    const direction = Math.sign(dx) || 1;
    return {
      x: a.x + direction * (rect.width / 2 + padding),
      y: a.y + (dy / Math.abs(dx)) * rect.width / 2,
      nx: direction,
      ny: 0,
    };
  }
  const direction = Math.sign(dy) || 1;
  return {
    x: a.x + (dx / (Math.abs(dy) || 1)) * rect.height / 2,
    y: a.y + direction * (rect.height / 2 + padding),
    nx: 0,
    ny: direction,
  };
}
function arrowPath(
  card: TourRect,
  target: TourRect | null,
  index = 0,
  count = 1,
): string | null {
  if (!target || overlap(card, padded(target, 10))) return null;
  const start = edgePoint(card, center(target), 8),
    end = edgePoint(target, center(card), 12),
    spread = (index - (count - 1) / 2) * 12;
  if (start.nx)
    start.y = clamp(start.y + spread, card.y + 16, card.y + card.height - 16);
  else
    start.x = clamp(start.x + spread, card.x + 16, card.x + card.width - 16);
  const bend = Math.min(80, Math.hypot(end.x - start.x, end.y - start.y) * 0.35);
  return `M ${start.x} ${start.y} C ${start.x + start.nx * bend} ${start.y + start.ny * bend}, ${end.x + end.nx * bend} ${end.y + end.ny * bend}, ${end.x} ${end.y}`;
}

export function oppositeTheme(): "light" | "dark" {
  const source =
    document.querySelector(".showcase-table .qt-table") ??
    document.querySelector(".showcase-query") ??
    document.documentElement;
  const color = getComputedStyle(source).backgroundColor;
  const components = color.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
  return components[0]! * 0.2126 +
    components[1]! * 0.7152 +
    components[2]! * 0.0722 <
    128
    ? "light"
    : "dark";
}
export function GuidedTour({ tour }: { tour: GuidedTourApi }) {
  const heading = useRef<HTMLHeadingElement>(null),
    card = useRef<HTMLElement>(null),
    pressingCard = useRef(false);
  const [layout, setLayout] = useState<TourLayout | null>(null);
  const [dragging, setDragging] = useState(false);
  const positions = useRef<Partial<Record<PositionScope, TourPoint>>>({});
  const drag = useRef<CardDrag | null>(null);
  const measure = useRef<() => void>();
  const state = useRef(tour);
  state.current = tour;
  useLayoutEffect(() => {
    if (!tour.active) {
      positions.current = {};
      drag.current = null;
      pressingCard.current = false;
      setDragging(false);
      return;
    }
    let frame = 0,
      releaseFrame = 0;
    const observed = new Set<Element>();
    const observer = new ResizeObserver(() => schedule());
    const watch = (element: Element | null | undefined) => {
      if (element && !observed.has(element)) {
        observed.add(element);
        observer.observe(element);
      }
    };
    const update = () => {
      if (!card.current || (pressingCard.current && !drag.current)) return;
      for (const element of observed)
        if (!element.isConnected) {
          observer.unobserve(element);
          observed.delete(element);
        }
      const viewport = viewportRect();
      const live = state.current;
      const element = live.locateTarget();
      const modal = document.querySelector<HTMLElement>(
        "[role=dialog][aria-modal=true]",
      );
      const surface =
        element?.closest(".qt-menu-surface,[role=dialog]") ?? modal;
      const region = live.locateRegion();
      watch(element);
      watch(surface);
      watch(card.current);
      watch(region);
      const target = element ? visibleRect(element, viewport) : null;
      const regionBounds = region ? visibleRect(region, viewport) : null;
      const resultElements =
        live.complete && !modal ? live.locateResults() : [];
      if (
        live.step?.id === "reorder" &&
        !live.complete &&
        !modal &&
        element?.nextElementSibling instanceof HTMLElement
      )
        resultElements.push(element.nextElementSibling);
      const highlights = regionBounds ? [regionBounds] : [
        target,
        ...resultElements.map((e) => {
          watch(e);
          return visibleRect(e, viewport);
        }),
      ]
        .filter((r): r is TourRect => !!r)
        .filter(
          (r, i, all) =>
            all.findIndex(
              (other) => JSON.stringify(other) === JSON.stringify(r),
            ) === i,
        );
      const arrowTargets = regionBounds && target ? [target] : highlights;
      const surfaceBounds = surface ? visibleRect(surface, viewport) : null;
      const cutouts = surfaceBounds ? [surfaceBounds] : highlights;
      const bounds = card.current.getBoundingClientRect();
      document.body.style.setProperty(
        "--showcase-tour-modal-space",
        `${modal ? bounds.height + 24 : 0}px`,
      );
      const position = positions.current[modal ? "editor" : "page"];
      const placement = position
        ? fitCard(viewport, bounds.width, bounds.height, position)
        : placeCard(
            viewport,
            bounds.width,
            bounds.height,
            target,
            cutouts[0] ?? null,
            !!modal,
            cutouts.slice(1),
          );
      const next = {
        viewport,
        target,
        highlights,
        cutouts,
        card: placement,
        arrows: arrowTargets
          .map((r, i) => arrowPath(placement, r, i, arrowTargets.length))
          .filter((p): p is string => !!p),
        theme: oppositeTheme(),
      };
      setLayout((old) =>
        JSON.stringify(old) === JSON.stringify(next) ? old : next,
      );
    };
    function schedule() {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          update();
        });
    }
    const release = () => {
      cancelAnimationFrame(releaseFrame);
      // An outside click may close a menu on pointerdown. Wait until click has
      // reached the pressed button before repositioning the card.
      releaseFrame = requestAnimationFrame(() => {
        pressingCard.current = false;
        schedule();
      });
    };
    const themeObserver = new MutationObserver(schedule);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    const backdrop = document.querySelector(".showcase");
    if (backdrop)
      themeObserver.observe(backdrop, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme"],
      });
    document.body.classList.add("showcase-tour-running");
    measure.current = schedule;
    update();
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("animationend", schedule, true);
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", release, true);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(releaseFrame);
      observer.disconnect();
      themeObserver.disconnect();
      measure.current = undefined;
      document.body.classList.remove("showcase-tour-running");
      document.body.style.removeProperty("--showcase-tour-modal-space");
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("animationend", schedule, true);
      document.removeEventListener("pointerup", release, true);
      document.removeEventListener("pointercancel", release, true);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [tour.active, tour.locateTarget]);
  useLayoutEffect(() => {
    measure.current?.();
  });
  useEffect(() => {
    if (
      tour.active &&
      !tour.modalOpen &&
      !document.querySelector(".qt-menu-surface")
    )
      heading.current?.focus({ preventScroll: true });
  }, [tour.step?.id, tour.modalOpen]);
  const positionScope = (): PositionScope =>
    document.querySelector('[role=dialog][aria-modal=true]') ? "editor" : "page";
  function startDrag(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || !event.isPrimary || !(event.target instanceof Element))
      return;
    if (!event.target.closest(".showcase-tour-drag")) return;
    const control = event.target.closest("button,select");
    if (control && !control.classList.contains("showcase-tour-grip")) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    event.preventDefault();
    drag.current = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origin: { x: bounds.x, y: bounds.y },
      scope: positionScope(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }
  function moveDrag(event: PointerEvent<HTMLElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    positions.current[active.scope] = {
      x: active.origin.x + event.clientX - active.start.x,
      y: active.origin.y + event.clientY - active.start.y,
    };
    measure.current?.();
  }
  function endDrag(event: PointerEvent<HTMLElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    measure.current?.();
  }
  function resetPosition() {
    delete positions.current[positionScope()];
    measure.current?.();
  }
  function moveWithKeys(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Home") {
      event.preventDefault();
      resetPosition();
      return;
    }
    const delta = event.shiftKey ? 6 : 24;
    const moves: Record<string, TourPoint> = {
      ArrowLeft: { x: -delta, y: 0 },
      ArrowRight: { x: delta, y: 0 },
      ArrowUp: { x: 0, y: -delta },
      ArrowDown: { x: 0, y: delta },
    };
    const move = moves[event.key];
    if (!move || !card.current) return;
    event.preventDefault();
    const bounds = card.current.getBoundingClientRect();
    positions.current[positionScope()] = {
      x: bounds.x + move.x,
      y: bounds.y + move.y,
    };
    measure.current?.();
  }
  if (!tour.active || !tour.step || !tour.chapter) return null;
  const modal = document.querySelector<HTMLElement>(
    "[role=dialog][aria-modal=true]",
  );
  const result = tour.complete && !tour.step.readOnly && !tour.modalOpen;
  const viewing = result || tour.step.readOnly;
  const nextTopic = tour.chapters[tour.chapterIndex + 1];
  const continueLabel = tour.preview
    ? "Learn more"
    : tour.index === tour.count - 1 ? "Finish tour" : "Continue";
  const cardNode = (
    <section
      ref={card}
      className={`showcase-tour${tour.modalOpen ? " showcase-tour--editor" : ""}`}
      data-tour-theme={layout?.theme ?? oppositeTheme()}
      aria-label="Guided tour"
      data-tour-step={tour.step.id}
      data-tour-chapter={tour.chapter.id}
      data-tour-result={result}
      data-tour-preview={tour.preview}
      data-tour-state={tour.running ? "working" : viewing ? "view" : "act"}
      data-tour-dragging={dragging}
      onPointerDownCapture={() => {
        pressingCard.current = true;
      }}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      style={{
        left: layout?.card.x ?? 12,
        top: layout?.card.y ?? 12,
        maxWidth: layout ? layout.viewport.width - 24 : undefined,
        maxHeight: layout ? layout.viewport.height - 24 : undefined,
      }}
    >
      <div className="showcase-tour-top showcase-tour-drag">
        <button
          className="showcase-icon-button showcase-tour-grip"
          type="button"
          aria-label="Move tour card"
          title="Drag to move. Use arrow keys to move or Home to restore."
          onKeyDown={moveWithKeys}
          onDoubleClick={resetPosition}
        >
          <Icon name="grip" size={15} />
        </button>
        <select
          className="showcase-tour-chapters"
          aria-label="Choose a topic"
          value={tour.chapter.id}
          disabled={tour.running || tour.modalOpen}
          onChange={(e) => tour.goChapter(e.target.value as ChapterId)}
        >
          {tour.chapters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <button
          className="showcase-icon-button"
          type="button"
          aria-label="End tour"
          title="End tour"
          onClick={tour.end}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      <div
        className="showcase-tour-progress"
        role="progressbar"
        aria-label="Tour progress"
        aria-valuemin={0}
        aria-valuemax={tour.count}
        aria-valuenow={tour.index + (!tour.preview && tour.complete ? 1 : 0)}
        aria-valuetext={`${tour.chapter.title}: ${tour.step.title}`}
      >
        {tour.chapters.map((c, i) => (
          <span key={c.id} className="showcase-tour-progress-part" title={c.title}>
            <span
              style={{
                width: `${i < tour.chapterIndex ? 100 : i > tour.chapterIndex || tour.preview ? 0 : ((tour.chapterLesson - 1 + (tour.complete ? 1 : 0)) / tour.chapterCount) * 100}%`,
              }}
            />
          </span>
        ))}
      </div>
      <div className="showcase-tour-heading showcase-tour-drag">
        <button
          type="button"
          className="showcase-icon-button showcase-tour-state"
          aria-label={tour.preview ? "Show this feature" : viewing ? "Show the result" : "Show the control"}
          title={tour.preview ? "Explore this feature" : viewing ? "Review the result" : "Take action · show the control"}
          aria-busy={tour.running}
          onClick={tour.showTarget}
        >
          <Icon name={tour.running ? "refresh" : viewing ? "eye" : "pointer"} size={19} />
        </button>
        <h2 ref={heading} tabIndex={-1}>
          {tour.step.title}
        </h2>
      </div>
      <p id="showcase-tour-instruction">
        {result ? tour.step.result : tour.step.instruction}
      </p>
      {tour.step.formula && !result && (
        <pre className="showcase-tour-formula">
          <code>{tour.step.formula}</code>
        </pre>
      )}
      <div
        className="showcase-tour-announcement"
        role="status"
        aria-live="polite"
      >
        {tour.running ? "Applying the action…" : tour.preview ? "Choose Learn more to try this topic, or skip ahead." : tour.blocked ? "Waiting for results…" : viewing ? "Ready to continue." : "Try the highlighted control, or choose Do it for me."}
      </div>
      {tour.actionError && (
        <p className="showcase-tour-error" role="alert">
          {tour.actionError}
        </p>
      )}
      <div className="showcase-tour-actions" role="group" aria-label="Tour controls">
        {!tour.modalOpen && (
          <button
            type="button"
            className="showcase-icon-button"
            aria-label="Previous step"
            title="Previous step"
            disabled={tour.preview ? tour.chapterIndex === 0 || !tour.canChoose : tour.index === 0 || tour.blocked}
            onClick={tour.back}
          >
            <Icon name="arrowLeft" size={18} />
          </button>
        )}
        {!tour.step.readOnly && !result && (
          <button
            type="button"
            className="qt-btn qt-btn-primary showcase-tour-do"
            disabled={tour.blocked}
            onClick={() => void tour.doIt()}
          >
            {tour.running ? "Doing it…" : "Do it for me"}
          </button>
        )}
        {!tour.modalOpen && viewing && (
          <button
            type="button"
            className={`qt-btn qt-btn-primary showcase-tour-next${tour.preview ? " showcase-tour-learn" : ""}`}
            aria-label={continueLabel}
            title={continueLabel}
            disabled={!tour.canAdvance}
            onClick={tour.next}
          >
            {tour.preview && "Learn more"}
            <Icon name={tour.index === tour.count - 1 ? "check" : "arrowRight"} size={19} />
          </button>
        )}
        {!tour.modalOpen && (nextTopic || tour.preview) && (
          <button
            type="button"
            className={`showcase-icon-button${tour.preview ? " showcase-tour-skip" : ""}`}
            aria-label={nextTopic ? "Skip to next topic" : "Finish tour"}
            title={nextTopic ? `Skip to ${nextTopic.title}` : "Finish tour"}
            disabled={tour.preview ? !tour.canChoose : tour.blocked}
            onClick={tour.nextChapter}
          >
            {tour.preview && (nextTopic ? "Skip" : "Finish")}
            <Icon name={nextTopic ? "skipForward" : "check"} size={18} />
          </button>
        )}
      </div>
    </section>
  );
  return createPortal(
    <div
      className="showcase-tour-overlay"
      data-tour-theme={layout?.theme ?? oppositeTheme()}
    >
      {layout && (
        <svg
          className="showcase-tour-spotlight"
          aria-hidden="true"
          width="100%"
          height="100%"
        >
          <defs>
            <mask id="showcase-tour-mask" maskUnits="userSpaceOnUse">
              <rect width="100%" height="100%" fill="white" />
              {/* Editor cards live in the dialog's focus scope, beneath this
                  global scrim. Keep their opposite theme undimmed too. */}
              <rect {...layout.card} rx="12" fill="black" />
              {layout.cutouts.map((rect, i) => (
                <rect key={i} {...padded(rect, 7)} rx="10" fill="black" />
              ))}
            </mask>
            <marker
              id="showcase-tour-arrowhead"
              markerWidth="10"
              markerHeight="10"
              refX="8"
              refY="5"
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <path
                d="M 1 1 L 8 5 L 1 9"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              />
            </marker>
          </defs>
          <rect
            className="showcase-tour-scrim"
            width="100%"
            height="100%"
            mask="url(#showcase-tour-mask)"
          />
          {layout.highlights.map((rect, i) => (
            <rect
              key={i}
              className={`showcase-tour-ring${result ? " showcase-tour-ring--result" : ""}`}
              {...padded(rect, 5)}
              rx="8"
            />
          ))}
          {layout.arrows.map((path, i) => (
            <path
              key={i}
              className={`showcase-tour-arrow${result ? " showcase-tour-arrow--result" : ""}`}
              d={path}
              markerEnd="url(#showcase-tour-arrowhead)"
            />
          ))}
        </svg>
      )}
      {modal ? createPortal(cardNode, modal) : cardNode}
    </div>,
    document.body,
  );
}
