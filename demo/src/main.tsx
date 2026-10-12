import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
const PostgresDemo = lazy(() =>
  import("./PostgresDemo").then((module) => ({ default: module.PostgresDemo })),
);
const DateMetricsPrototype = lazy(() =>
  import("./DateMetricsPrototype").then((module) => ({
    default: module.DateMetricsPrototype,
  })),
);

const PlaygroundFeedback = import.meta.env.DEV
  ? lazy(() =>
      import("./PlaygroundFeedback").then((module) => ({
        default: module.PlaygroundFeedback,
      })),
    )
  : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {window.location.pathname.startsWith("/date-metrics-workbench") ? (
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
