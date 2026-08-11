import { createSignal, Show, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";

interface DropdownProps {
  trigger: (onClick: () => void) => JSX.Element;
  children: JSX.Element;
}

export function Dropdown(props: DropdownProps) {
  const [open, setOpen] = createSignal(false);
  let ref: HTMLDivElement | undefined;

  function handleClickOutside(e: MouseEvent) {
    if (ref && !ref.contains(e.target as Node)) {
      setOpen(false);
    }
  }

  onMount(() => {
    document.addEventListener("mousedown", handleClickOutside);
  });

  onCleanup(() => {
    document.removeEventListener("mousedown", handleClickOutside);
  });

  return (
    <div class="relative" ref={ref}>
      {props.trigger(() => setOpen((v) => !v))}
      <Show when={open()}>
        <div class="absolute top-full left-0 z-50 mt-1 min-w-[180px] rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          {props.children}
        </div>
      </Show>
    </div>
  );
}

interface DropdownItemProps {
  onClick: () => void;
  class?: string;
  children: JSX.Element;
}

export function DropdownItem(props: DropdownItemProps) {
  return (
    <button
      onClick={props.onClick}
      class={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50 transition-colors ${props.class ?? ""}`}
    >
      {props.children}
    </button>
  );
}

export function DropdownSeparator() {
  return <div class="my-1 border-t border-slate-100" />;
}
