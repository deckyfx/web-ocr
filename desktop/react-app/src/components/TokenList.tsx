import { TokenCard, type Definition, type Token } from "./TokenCard";

type Props = {
  tokens: Token[];
  definitions: Definition[];
};

// POS values that are particles, auxiliaries, punctuation — skip cards for these
const SKIP_POS = new Set(["助詞", "助動詞", "記号", "補助記号", "接続詞", "感動詞"]);

export function TokenList({ tokens, definitions }: Props) {
  const cards = tokens
    .map((t, i) => ({ token: t, def: definitions[i] ?? null }))
    .filter(({ token }) => !SKIP_POS.has(token.pos));

  if (cards.length === 0) {
    return (
      <div className="px-4 py-2 text-xs text-[var(--overlay0)]">No tokens to display.</div>
    );
  }

  return (
    <div className="px-4 pb-4">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--overlay0)] mb-2 mt-3">
        Tokens ({cards.length})
      </div>
      {cards.map(({ token, def }, i) => (
        <TokenCard key={i} token={token} definition={def} />
      ))}
    </div>
  );
}
