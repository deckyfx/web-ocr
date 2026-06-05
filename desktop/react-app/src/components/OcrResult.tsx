type Props = {
  text: string;
  translation?: string;
};

export function OcrResult({ text, translation }: Props) {
  const copy = (t: string) => navigator.clipboard.writeText(t).catch(() => {});

  return (
    <div className="px-4 pt-3 pb-1">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--overlay0)] mb-1">
        OCR Text
      </div>
      <pre
        className="text-sm text-[var(--text)] bg-[var(--surface0)] rounded-md p-2.5 whitespace-pre-wrap break-words max-h-24 overflow-y-auto leading-relaxed"
      >
        {text}
      </pre>
      <button
        className="mt-1 text-xs text-[var(--blue)] bg-[var(--surface0)] border border-[var(--surface1)] rounded px-2.5 py-1 cursor-pointer hover:bg-[var(--surface1)] transition-colors"
        onClick={() => copy(text)}
      >
        Copy
      </button>

      {translation && (
        <>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--overlay0)] mb-1 mt-3">
            Translation
          </div>
          <pre className="text-sm text-[var(--text)] bg-[var(--surface0)] rounded-md p-2.5 whitespace-pre-wrap break-words max-h-24 overflow-y-auto leading-relaxed">
            {translation}
          </pre>
          <button
            className="mt-1 text-xs text-[var(--blue)] bg-[var(--surface0)] border border-[var(--surface1)] rounded px-2.5 py-1 cursor-pointer hover:bg-[var(--surface1)] transition-colors"
            onClick={() => copy(translation)}
          >
            Copy
          </button>
        </>
      )}
    </div>
  );
}
