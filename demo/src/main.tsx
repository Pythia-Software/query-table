import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
const CellDisplayDemo = lazy(() => import("./CellDisplayDemo").then(module => ({ default: module.CellDisplayDemo })));
const FilterValueDemo = lazy(() => import("./FilterValueDemo").then(module => ({ default: module.FilterValueDemo })));
const MenuDemo = lazy(() =>
  import("./MenuDemo").then((module) => ({ default: module.MenuDemo })),
);
const PostgresDemo = lazy(() =>
  import("./PostgresDemo").then((module) => ({ default: module.PostgresDemo })),
);
const PropertiesDemo = lazy(() =>
  import("./PropertiesDemo").then((module) => ({
    default: module.PropertiesDemo,
  })),
);
const DateMetricsPrototype = lazy(() =>
  import("./DateMetricsPrototype").then((module) => ({
    default: module.DateMetricsPrototype,
  })),
);
const GroupingDemo = lazy(() => import("./grouping/GroupingDemo").then(module => ({ default: module.GroupingDemo })));

const PlaygroundFeedback = import.meta.env.DEV
  ? lazy(() =>
      import("./PlaygroundFeedback").then((module) => ({
        default: module.PlaygroundFeedback,
      })),
    )
  : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {window.location.pathname.startsWith("/saved-queries") ? (
      <App savedQueriesPrototype />
    ) : window.location.pathname.startsWith("/grouping") ? (
      <Suspense fallback={<p>Loading grouping playground…</p>}>
        <GroupingDemo />
      </Suspense>
    ) : window.location.pathname.startsWith("/cells") ? (
      <Suspense fallback={<p>Loading cell displays…</p>}><main className="qt-demo"><CellDisplayDemo /></main></Suspense>
    ) : window.location.pathname.startsWith("/objects") ? (
      <Suspense fallback={<p>Loading object playground…</p>}>
        <PropertiesDemo />
      </Suspense>
    ) : window.location.pathname.startsWith("/filter-values") ? (
      <Suspense fallback={<p>Loading filter playground…</p>}><FilterValueDemo /></Suspense>
    ) : window.location.pathname.startsWith("/menus") ? (
      <Suspense fallback={<p>Loading menu playground…</p>}>
        <MenuDemo />
      </Suspense>
    ) : window.location.pathname.startsWith("/date-metrics-workbench") ? (
      <App dateExample />
    ) : window.location.pathname.startsWith("/date-metrics") ? (
      <Suspense fallback={<p>Loading date metric example…</p>}>
        <DateMetricsPrototype />
      </Suspense>
    ) : window.location.pathname.startsWith("/postgres") ? (
      <Suspense fallback={<p>Loading PostgreSQL playground…</p>}>
        <PostgresDemo />
      </Suspense>
    ) : (
      <App />
    )}
    {PlaygroundFeedback && (
      <Suspense fallback={null}>
        <PlaygroundFeedback />
      </Suspense>
    )}
  </StrictMode>,
);
