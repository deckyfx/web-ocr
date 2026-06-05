export type Token = {
  surface: string;
  reading: string;
  dictionary_form: string;
  pos: string;
};

export type Definition = {
  word: string;
  reading: string;
  meanings: string[];
  jlpt?: string;
  is_common: boolean;
} | null;

type Props = {
  token: Token;
  definition: Definition;
};

export function TokenCard({ token, definition }: Props) {
  const word = definition?.word ?? token.surface;
  const reading = definition?.reading ?? token.reading;

  return (
    <div className="bg-[var(--surface0)] rounded-md px-2.5 py-2 mb-1.5">
      <div className="flex items-baseline flex-wrap gap-1.5 mb-1.5">
        <span className="text-[17px] font-semibold text-[var(--blue)]">{word}</span>
        {reading && reading !== word && (
          <span className="text-xs text-[var(--subtext0)]">{reading}</span>
        )}
        {definition?.jlpt && (
          <span className="text-[10px] font-bold bg-[var(--peach)] text-[var(--base)] rounded px-1 py-px leading-tight">
            {definition.jlpt.toUpperCase()}
          </span>
        )}
        {definition?.is_common && (
          <span className="text-[10px] font-semibold bg-[var(--green)] text-[var(--base)] rounded px-1 py-px leading-tight">
            common
          </span>
        )}
      </div>

      {definition?.meanings && definition.meanings.length > 0 ? (
        <div>
          {definition.meanings.slice(0, 3).map((m, i) => (
            <div
              key={i}
              className={`text-xs leading-snug break-words ${
                i === 0 ? "text-[var(--text)]" : "text-[var(--subtext0)] mt-0.5"
              }`}
            >
              {m}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-[var(--overlay0)]">{token.pos}</div>
      )}
    </div>
  );
}
