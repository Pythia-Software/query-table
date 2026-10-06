import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const PlaygroundFeedback = import.meta.env.DEV
  ? lazy(() => import("./PlaygroundFeedback").then((module) => ({ default: module.PlaygroundFeedback })))
  : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    {PlaygroundFeedback && <Suspense fallback={null}><PlaygroundFeedback /></Suspense>}
  </StrictMode>,
);
