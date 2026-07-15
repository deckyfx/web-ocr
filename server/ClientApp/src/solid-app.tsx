import "./styles.css";
import { render } from "solid-js/web";
import { Dashboard } from "./components/Dashboard";

// Map DOM element → SolidJS dispose function for clean unmounting
const disposers = new Map<Element, () => void>();

window.AppBridge = {
  mount(element: Element, _props: Record<string, unknown> = {}) {
    if (disposers.has(element)) return;
    const dispose = render(() => <Dashboard />, element);
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
