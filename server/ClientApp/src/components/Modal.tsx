import { createEffect, type JSX, Show } from "solid-js";
import { X } from "lucide-solid";

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: JSX.Element;
}

export function Modal(props: ModalProps) {
  createEffect(() => {
    if (!props.open) {
      document.body.style.overflow = "";
      return;
    }
    document.body.style.overflow = "hidden";
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKeyDown);
    };
  });

  return (
    <Show when={props.open}>
      {/* Backdrop */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose();
        }}
      >
        {/* Panel */}
        <div class="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
          {/* Header */}
          <div class="mb-4 flex items-center justify-between">
            <h2 id="modal-title" class="text-base font-semibold text-slate-800">{props.title}</h2>
            <button
              class="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              onClick={props.onClose}
              aria-label="Close"
            >
              <X class="h-4 w-4" />
            </button>
          </div>
          {props.children}
        </div>
      </div>
    </Show>
  );
}
