import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  createQueryLinkService,
  memoryQuerySnapshotCache,
  normalizeQueryState,
  queriesEqual,
  toServerQuery,
  type QueryLink,
} from "@pythia-software/query-table-core";
import { useQueryTable, type QueryTableApi } from "@pythia-software/query-table-react";
import { DataTable, QueryBuilder, ModalSurface, Icon, defaultRenderers, type RenderRegistry } from "@pythia-software/query-table-ui";
import { oppositeTheme } from "./tour";
import {
  createIntegrationHost, EXAMPLE_ORDERS, EXAMPLE_SCHEMA, EXAMPLE_VIEWS,
  REACT_STARTER, NATIVE_STARTER, SNAPSHOT_STARTER, type ExampleOrder,
} from "./integrationExamples";
import "./integrationGuide.css";

const REPO = "https://github.com/Pythia-Software/query-table";
const SLIDES = [
  { label: "Integrate", title: "A library inside your product", intro: "Choose your frontend and executor. The schema and query contract connect them." },
  { label: "Boundaries", title: "Query Table brings the interaction. You bring the data.", intro: "The UI describes a view. Your host decides what data it may access and how to execute it." },
  { label: "Defaults", title: "Start with a useful view", intro: "Set columns and sorting in the schema, or give a screen its own initial query. Try a starting view below." },
  { label: "Views & links", title: "Save the view. Share the query.", intro: "Named views use a storage adapter. Compact share links resolve immutable snapshots through your host." },
  { label: "Theme", title: "Make it feel like your app", intro: "React styles are scoped CSS tokens. Change two values and keep the same query, behavior, and components." },
] as const;

const PALETTES: Record<"light" | "dark", CSSProperties> = {
  light: {
    "--qt-bg": "#fffefa", "--qt-surface": "#fffefa", "--qt-text": "#29352f",
    "--qt-muted": "#637460", "--qt-border": "#dedfcd", "--qt-border-subtle": "#e8ede3",
    "--qt-header-bg": "#e8ede3", "--qt-accent": "#47786f", "--qt-accent-fg": "#fff",
    "--qt-accent-bg": "#e8ede3", colorScheme: "light",
  } as CSSProperties,
  dark: {
    "--qt-bg": "#192a24", "--qt-surface": "#192a24", "--qt-text": "#f3f6ee",
    "--qt-muted": "#bdd0c0", "--qt-border": "#456251", "--qt-border-subtle": "#30463a",
    "--qt-header-bg": "#30463a", "--qt-accent": "#cfe2c1", "--qt-accent-fg": "#1c3427",
    "--qt-accent-bg": "#30463a", colorScheme: "dark",
  } as CSSProperties,
};

const EXAMPLE_RENDERERS: RenderRegistry<ExampleOrder> = {
  ...defaultRenderers,
  "example-status": ({ value }) => <span className="qt-pill" data-example-status={String(value)}>{String(value)}</span>,
};

function DocLink({ path, children }: { path: string; children: ReactNode }) {
  return <a className="build-doc-link" href={`${REPO}/${path}`} target="_blank" rel="noopener noreferrer">{children}<Icon name="externalLink" size={13} /></a>;
}

function Code({ text, label, copy = false }: { text: string; label: string; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setCopied(false); setError(""); }, [text]);
  return <div className="build-code">
    <div className="build-code-heading"><span>{label}</span>{copy && <button type="button" className="qt-btn" aria-label={`Copy ${label}`} onClick={() => {
      void navigator.clipboard.writeText(text).then(() => { setCopied(true); setError(""); }).catch(() => setError("Copy isn't available here. Select the code below."));
    }}><Icon name={copied ? "check" : "copy"} size={13} />{copied ? "Copied" : "Copy"}</button>}</div>
    <pre><code>{text}</code></pre>
    {error && <p role="status">{error}</p>}
  </div>;
}

function ExampleTable({ api, editor = true, accent = "#47786f", radius = 6 }: {
  api: QueryTableApi<ExampleOrder>; editor?: boolean; accent?: string; radius?: number;
}) {
  return <div className="build-preview" style={{ ...PALETTES.light, "--qt-accent": accent, "--qt-accent-bg": "color-mix(in srgb, var(--qt-accent) 12%, var(--qt-bg))", "--qt-radius": `${radius}px` } as CSSProperties}>
    <div className="build-preview-caption"><span>Interactive example</span><span>{api.total ?? "…"} matching orders</span></div>
    {editor && <QueryBuilder api={api} fields={api.schema?.fields ?? EXAMPLE_SCHEMA.fields} total={api.total} />}
    <DataTable fields={api.visibleFields} rows={api.rows} query={api.query} onQueryChange={api.setQuery}
      total={api.total} rowId={api.rowId} renderers={EXAMPLE_RENDERERS} selection={api.selection}
      columnDrag={api.columnDrag} loading={api.loading} maxHeight={230} />
    <p className="build-preview-note">Sample orders. Changes stay in this example.</p>
  </div>;
}

function IntegrationPaths() {
  const [platform, setPlatform] = useState<"react" | "mac">("react");
  const [database, setDatabase] = useState<"postgres" | "sqlite" | "duckdb">("duckdb");
  const backends = {
    postgres: { name: "PostgreSQL", note: "The Go backend compiles allowed fields and query expressions into parameterized SQL. Your server executes the plans.", path: "blob/main/docs/host-integration-next-release.md" },
    sqlite: { name: "SQLite", note: "The Go backend includes SQLite planning and function registration. Your app supplies the driver, connection, and authorized source.", path: "blob/main/docs/backend-sqlite.md" },
    duckdb: { name: "DuckDB", note: "The TypeScript backend works with native DuckDB or DuckDB-Wasm. This demo executes its queries in the browser.", path: "tree/main/packages/duckdb" },
  };
  return <div className="build-paths">
    <div className="build-client">
      <div className="build-options" role="group" aria-label="Choose a frontend">
        <button className="qt-btn" aria-pressed={platform === "react"} onClick={() => setPlatform("react")}>React</button>
        <button className="qt-btn" aria-pressed={platform === "mac"} onClick={() => setPlatform("mac")}>Native macOS</button>
      </div>
      <h3>{platform === "react" ? "Ready-made UI or your own markup" : "SwiftUI + AppKit, with a native table"}</h3>
      <p>{platform === "react" ? "Use core primitives, headless React hooks, or the complete QueryBuilder and DataTable." : "Add QueryTableUI and QueryTableCore as Swift packages. Connect HTTPQueryTransport to your backend, or implement QueryTransport for local data."}</p>
      <details><summary>See the {platform === "react" ? "React" : "Swift"} integration</summary><Code label={platform === "react" ? "React starter" : "Swift starter"} text={platform === "react" ? REACT_STARTER : NATIVE_STARTER} copy /></details>
      <DocLink path={platform === "react" ? "tree/main/packages/ui" : "tree/main/native/macos"}>{platform === "react" ? "React setup" : "Native setup & compatibility"}</DocLink>
    </div>
    <div className="build-executors">
      <span className="build-kicker">Choose an executor</span>
      <div className="build-options" role="group" aria-label="Choose a database">
        {(Object.keys(backends) as (keyof typeof backends)[]).map(id => <button key={id} className="qt-btn" aria-pressed={database === id} onClick={() => setDatabase(id)}>{backends[id].name}</button>)}
      </div>
      <div className="build-connection"><Icon name="arrowDown" size={21} /><code>schema + query → rows + total + metrics</code></div>
      <p>{backends[database].note}</p>
      <DocLink path={backends[database].path}>{backends[database].name} integration</DocLink>
      <p className="build-caption">Both frontends share schema/query contracts. Supported features depend on the client and executor capabilities.</p>
    </div>
  </div>;
}

function Ownership({ api }: { api: QueryTableApi<ExampleOrder> }) {
  const [showRequest, setShowRequest] = useState(false);
  return <>
    <div className="build-ownership">
      <section><span className="build-kicker">Query Table</span><h3>The interaction and contract</h3><ul>
        <li>Editors, table, metrics, formatting, selection</li>
        <li>Query state, undo, URL encoding, adapter calls</li>
        <li>Bundled backend validation and SQL planning</li>
      </ul></section>
      <section><span className="build-kicker">Your host</span><h3>The application and execution</h3><ul>
        <li>Schema, stable IDs, trusted database bindings</li>
        <li>Authentication, authorized data, execution and limits</li>
        <li>Endpoints, drivers, consistent data snapshots</li>
        <li>Named views and shared-link persistence</li>
      </ul></section>
    </div>
    <div className="build-flow" aria-label="Query execution flow">
      <span><b>Query Table</b>Describe the view</span><Icon name="arrowRight" size={20} />
      <span><b>Your host + database</b>Execute the allowed query</span><Icon name="arrowRight" size={20} />
      <span><b>Query Table</b>Render rows and metrics</span>
    </div>
    <p className="build-caption">Here, the browser is the host: DuckDB executes, local storage keeps views. A server-backed app supplies those adapters and its own access rules.</p>
    <button type="button" className="qt-btn" onClick={() => setShowRequest(value => !value)} aria-expanded={showRequest}>Inspect an example request</button>
    {showRequest && <Code label="Readable row-query contract" text={JSON.stringify(toServerQuery(api.query, EXAMPLE_SCHEMA), null, 2)} />}
    <DocLink path="blob/main/docs/host-integration-next-release.md">Host integration guide</DocLink>
  </>;
}

function Defaults({ api }: { api: QueryTableApi<ExampleOrder> }) {
  const current = EXAMPLE_VIEWS.find(view => queriesEqual(api.query, normalizeQueryState(view.query, api.defaults))) ?? null;
  return <>
    <div className="build-options" role="group" aria-label="Starting view">
      {EXAMPLE_VIEWS.map(view => <button key={view.id} type="button" className="qt-btn" aria-pressed={current?.id === view.id} onClick={() => api.setQuery(view.query)}>{view.label}</button>)}
    </div>
    <ExampleTable api={api} />
    <details><summary>How to configure this starting view</summary><Code label="Defaults configuration" text={(current ?? EXAMPLE_VIEWS[0]!).code} copy /></details>
    <p className="build-caption">Schema defaults cover column visibility, width, sorting, and page size. initialQuery can add a focused filter; a saved view can become the user's default.</p>
  </>;
}

function ViewsAndLinks({ api, host }: { api: QueryTableApi<ExampleOrder>; host: ReturnType<typeof createIntegrationHost> }) {
  const [link, setLink] = useState<QueryLink | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <>
    <div className="build-options" role="group" aria-label="Example view controls">
      <button className="qt-btn" onClick={() => api.setQuery(EXAMPLE_VIEWS[1]!.query)}>Focus open orders</button>
      <button className="qt-btn" onClick={() => api.setQuery(EXAMPLE_VIEWS[0]!.query)}>Reset example</button>
      <button className="qt-btn qt-btn--primary" disabled={busy || api.saved.loading || !api.restoration.ready} onClick={() => void run(async () => {
        const saved = await api.saved.save(`Example view ${api.saved.items.length + 1}`);
        setStatus(`Saved “${saved.name}”. Reset the example, then restore it below.`);
      })}><Icon name="bookmark" size={14} />Save example view</button>
    </div>
    <div className="build-saved" aria-label="Example saved views">
      {api.saved.items.length ? api.saved.items.map(saved => <button className="qt-btn" key={saved.id} onClick={() => {
        api.saved.load(saved.id); setStatus(`Restored “${saved.name}”.`);
      }}>Restore {saved.name}</button>) : <span>Your saved examples will appear here.</span>}
    </div>
    <ExampleTable api={api} editor={false} />
    <div className="build-share">
      <div><h3>Full state or a short reference</h3><p>The inline form carries the query. A short form stores it with your host and carries only its immutable code.</p></div>
      <div className="build-options">
        <button className="qt-btn" disabled={busy || !api.restoration.ready} onClick={() => {
          const inline = createQueryLinkService(EXAMPLE_SCHEMA.name, undefined, { cache: memoryQuerySnapshotCache(), maxUrlBytes: 12000 });
          setLink(inline.local(api.query, "https://your-app.example/orders")); setStatus("Inline state needs no snapshot server.");
        }}>Create inline link</button>
        <button className="qt-btn" disabled={busy || !api.restoration.ready} onClick={() => void run(async () => {
          setLink(await api.links.create(undefined, { baseUrl: "https://your-app.example/orders" }));
          setStatus(`The example host holds ${host.publishedCount} immutable snapshot${host.publishedCount === 1 ? "" : "s"}.`);
        })}>Create short link</button>
      </div>
      {link && <div className="build-link-result" data-link-kind={link.kind}>
        <span className="build-kicker">Example application URL · {link.bytes} bytes</span><code>{link.url}</code>
        <button className="qt-btn" disabled={busy} onClick={() => void run(async () => {
          const receiver = createQueryLinkService(EXAMPLE_SCHEMA.name, host.snapshots, { cache: memoryQuerySnapshotCache() });
          const restored = await receiver.resolve(link.url);
          if (!restored) throw Error("The example link has no query.");
          api.setQuery(restored);
          setStatus(link.kind === "inline" ? "Decoded the inline query and restored the example." : `A fresh resolver read the snapshot from the example host (${host.reads} read${host.reads === 1 ? "" : "s"}) and restored the example.`);
        })}>Open link in preview<Icon name="arrowRight" size={14} /></button>
      </div>}
    </div>
    <p className="build-caption">Simulated host: snapshots and named views live in memory while this guide is open. These example URLs are illustrative. Real cross-device links need your durable snapshot service.</p>
    {status && <p className="build-status" role="status">{status}</p>}
    {error && <p className="build-error" role="alert">{error}</p>}
    <details><summary>Connect your storage and snapshot service</summary><Code label="Storage & link adapters" text={SNAPSHOT_STARTER} copy /></details>
    <DocLink path="blob/main/docs/url-state-and-saved-search-design.md">Saved views & link contract</DocLink>
  </>;
}

function Themes({ api }: { api: QueryTableApi<ExampleOrder> }) {
  const [accent, setAccent] = useState("#47786f");
  const [radius, setRadius] = useState(6);
  return <>
    <div className="build-theme-controls">
      <label>Accent<select aria-label="Example accent" value={accent} onChange={event => setAccent(event.target.value)}><option value="#47786f">Fern</option><option value="#6549b6">Violet</option><option value="#a64b30">Terracotta</option></select></label>
      <label>Corners<select aria-label="Example corners" value={radius} onChange={event => setRadius(Number(event.target.value))}><option value={2}>Square</option><option value={6}>Soft</option><option value={14}>Rounded</option></select></label>
      <button className="qt-btn" onClick={() => { const row = api.rows[0]; if (row) api.selection.toggle(row.id); }}>Toggle first row selection</button>
    </div>
    <ExampleTable api={api} editor={false} accent={accent} radius={radius} />
    <Code label="Scoped theme" text={`.my-query-table {\n  --qt-accent: ${accent};\n  --qt-radius: ${radius}px;\n}`} copy />
    <p className="build-caption">Palette, typography, column roles, cell renderers, and classNames slots offer more control. Native macOS apps style their SwiftUI/AppKit views and provide native cell renderers.</p>
    <DocLink path="tree/main/packages/ui#client-palettes-and-column-roles">Theme & renderer options</DocLink>
  </>;
}

function IntegrationSlides({ onClose }: { onClose(): void }) {
  const [index, setIndex] = useState(0);
  const host = useMemo(createIntegrationHost, []);
  const links = useMemo(() => ({ cache: host.cache, maxUrlBytes: 12000 }), [host]);
  const api = useQueryTable({ schema: EXAMPLE_SCHEMA, clientRows: EXAMPLE_ORDERS, storage: host.storage, links, initialQuery: EXAMPLE_VIEWS[0]!.query, syncUrl: false, debounceMs: 0 });
  const slide = SLIDES[index]!;
  useEffect(() => {
    document.querySelector<HTMLElement>('.build-guide [data-build-heading]')?.focus({ preventScroll: true });
    document.querySelector('.build-slide')?.scrollTo({ top: 0 });
  }, [index]);
  return <div className="build-slides" data-build-slide={index}>
    <nav className="build-nav" aria-label="Integration topics">{SLIDES.map((item, i) => <button type="button" key={item.label} aria-current={index === i ? "step" : undefined} onClick={() => setIndex(i)}>{item.label}</button>)}</nav>
    <div className="build-slide">
      <h2 data-build-heading tabIndex={-1}>{slide.title}</h2><p className="build-intro">{slide.intro}</p>
      {index === 0 && <IntegrationPaths />}
      {index === 1 && <Ownership api={api} />}
      {index === 2 && <Defaults api={api} />}
      {index === 3 && <ViewsAndLinks api={api} host={host} />}
      {index === 4 && <Themes api={api} />}
      {api.error && <p className="build-error" role="alert">{api.error.message}</p>}
    </div>
    <footer className="build-footer">
      <button type="button" className="qt-btn" disabled={index === 0} onClick={() => setIndex(i => i - 1)} aria-label="Previous integration slide"><Icon name="arrowLeft" size={16} /></button>
      <DocLink path="blob/main/README.md#install">Get started</DocLink>
      <button type="button" className="qt-btn qt-btn--primary" onClick={() => index === SLIDES.length - 1 ? onClose() : setIndex(i => i + 1)}>{index === SLIDES.length - 1 ? "Back to demo" : "Next"}<Icon name="arrowRight" size={16} /></button>
    </footer>
  </div>;
}

export function IntegrationGuide({ mode, returnFocus, onStart, onClose }: { mode: "invite" | "slides"; returnFocus: HTMLElement | null; onStart(): void; onClose(): void }) {
  const [appearance] = useState(oppositeTheme);
  return <div style={PALETTES[appearance]}>
    <ModalSurface title="Build with Query Table" className="qt-modal build-guide" backdropClassName="build-backdrop" onClose={onClose} returnFocus={returnFocus} initialFocus="[data-build-heading]">
      {mode === "invite" ? <div className="build-invite">
        <Icon name="panelDefinition" size={28} /><h2 data-build-heading tabIndex={-1}>Take this into your app</h2>
        <p>Everything you just explored is a library. See how to connect React or native macOS, choose an executor, and bring your own defaults, saved views, links, and theme.</p>
        <div><button className="qt-btn" onClick={onClose}>Keep exploring</button><button className="qt-btn qt-btn--primary" onClick={onStart}>See integration examples<Icon name="arrowRight" size={16} /></button></div>
      </div> : <IntegrationSlides onClose={onClose} />}
    </ModalSurface>
  </div>;
}
