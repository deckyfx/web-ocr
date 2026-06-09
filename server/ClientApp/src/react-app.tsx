import "./styles.css";
import { createRoot, type Root } from "react-dom/client";
import { Dashboard } from "./components/Dashboard";

// Map DOM element → React root so we can unmount cleanly
const roots = new Map<Element, Root>();

window.ReactBridge = {
  mount(element: Element, props: Record<string, unknown> = {}) {
    if (roots.has(element)) return;
    const root = createRoot(element);
    roots.set(element, root);
    root.render(<Dashboard {...(props as any)} />);
  },
  unmount(element: Element) {
    roots.get(element)?.unmount();
    roots.delete(element);
  },
};

declare global {
  interface Window {
    ReactBridge: {
      mount(element: Element, props?: Record<string, unknown>): void;
      unmount(element: Element): void;
    };
  }
}
