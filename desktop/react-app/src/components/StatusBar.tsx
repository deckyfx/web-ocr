type Props = {
  status: "idle" | "capturing" | "selecting" | "analyzing" | "error";
  error?: string;
};

export function StatusBar({ status, error }: Props) {
  if (status === "idle") {
    return (
      <div className="flex items-center justify-center h-full text-[var(--overlay0)] text-sm select-none">
        Press <kbd className="mx-1.5 px-1.5 py-0.5 rounded text-xs bg-[var(--surface0)] text-[var(--subtext1)] border border-[var(--surface1)]">Super+Shift+O</kbd> to capture
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="p-4 text-[var(--red)] text-sm break-words">
        {error ?? "An error occurred."}
      </div>
    );
  }

  const labels: Record<string, string> = {
    capturing:  "Capturing screen…",
    selecting:  "Draw a selection rectangle",
    analyzing:  "Analyzing…",
  };

  return (
    <div className="flex items-center gap-3 p-4 text-[var(--text)] text-sm">
      <span
        className="inline-block w-4 h-4 rounded-full border-2 border-[var(--surface1)] border-t-[var(--blue)]"
        style={{ animation: "spin 0.7s linear infinite", flexShrink: 0 }}
      />
      {labels[status] ?? status}
    </div>
  );
}
