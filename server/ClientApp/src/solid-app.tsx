import "./styles.css";
import { lazy } from "solid-js";
import { render } from "solid-js/web";
import { HashRouter, Route } from "@solidjs/router";
import { Layout } from "./components/Layout";
import { Dashboard } from "./components/Dashboard";

// Lazy-load pages to keep initial bundle small
const JobsListPage = lazy(() =>
  import("./pages/JobsListPage").then((m) => ({ default: m.JobsListPage })),
);
const StudioPage = lazy(() =>
  import("./pages/StudioPage").then((m) => ({ default: m.StudioPage })),
);
const LibraryPage = lazy(() =>
  import("./pages/LibraryPage").then((m) => ({ default: m.LibraryPage })),
);
const VolumePage = lazy(() =>
  import("./pages/VolumePage").then((m) => ({ default: m.VolumePage })),
);
const ChapterPage = lazy(() =>
  import("./pages/ChapterPage").then((m) => ({ default: m.ChapterPage })),
);

function App() {
  return (
    <HashRouter>
      <Route path="/" component={Layout}>
        <Route path="/" component={Dashboard} />
        <Route path="/jobs" component={JobsListPage} />
        <Route path="/jobs/:id" component={StudioPage} />
        <Route path="/library" component={LibraryPage} />
        <Route path="/library/:volumeId" component={VolumePage} />
        <Route path="/library/chapters/:chapterId" component={ChapterPage} />
      </Route>
    </HashRouter>
  );
}

// ---------------------------------------------------------------------------
// AppBridge — called by Blazor Index.razor
// ---------------------------------------------------------------------------

const disposers = new Map<Element, () => void>();

window.AppBridge = {
  mount(element: Element, _props: Record<string, unknown> = {}) {
    if (disposers.has(element)) return;
    const dispose = render(() => <App />, element);
    disposers.set(element, dispose);
  },
  unmount(element: Element) {
    disposers.get(element)?.();
    disposers.delete(element);
  },
};

declare global {
  interface Window {
    AppBridge: {
      mount(element: Element, props?: Record<string, unknown>): void;
      unmount(element: Element): void;
    };
  }
}

// Static Blazor page — auto-mount into #solid-root; app.js runs after the
// div is already in the DOM so no DOMContentLoaded wait is needed.
const solidRoot = document.getElementById("solid-root");
if (solidRoot) window.AppBridge.mount(solidRoot);
