import { Modal } from "./Modal";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  confirmClass?: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  return (
    <Modal open={props.open} title={props.title} onClose={props.onCancel}>
      <p class="mb-6 text-sm text-slate-600">{props.message}</p>
      <div class="flex justify-end gap-2">
        <button
          class="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          disabled={props.loading}
          onClick={props.onCancel}
        >
          Cancel
        </button>
        <button
          class={
            props.confirmClass ??
            "rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          }
          disabled={props.loading}
          onClick={props.onConfirm}
        >
          {props.loading ? "Deleting…" : (props.confirmLabel ?? "Delete")}
        </button>
      </div>
    </Modal>
  );
}
