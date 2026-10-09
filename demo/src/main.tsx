import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
const PostgresDemo = lazy(() => import("./PostgresDemo").then(module => ({ default: module.PostgresDemo })));

const PlaygroundFeedback = import.meta.env.DEV
  ? lazy(() => import("./PlaygroundFeedback").then((module) => ({ default: module.PlaygroundFeedback })))
  : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {window.location.pathname.startsWith("/postgres") ? <Suspense fallback={<p>Loading PostgreSQL playground…</p>}><PostgresDemo /></Suspense> : <App />}
    {PlaygroundFeedback && <Suspense fallback={null}><PlaygroundFeedback /></Suspense>}
  </StrictMode>,
);
