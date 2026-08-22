import { Trash2 } from "lucide-react";
import type { TextSegBlock } from "../types";

interface Props {
  box: TextSegBlock | null;
  index: number | null;
  onDelete: (id: string) => void;
}

export function TextSegDetail({ box, index, onDelete }: Props) {
  if (!box || index === null) return null;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          TextSeg #{index + 1}
        </span>
        <button
          onClick={() => onDelete(box.id)}
          className="p-1.5 rounded-lg text-red-400 hover:bg-red-400/10 transition-colors"
          title="Delete block"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="grid grid-cols-4 gap-1.5 text-xs">
        {(["x", "y", "w", "h"] as const).map((k) => (
          <div key={k} className="bg-gray-800 rounded-lg px-2 py-1.5">
            <div className="text-gray-500 text-[10px] uppercase">{k}</div>
            <div className="text-gray-200 font-mono">{Math.round(box[k])}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-gray-500">Source text</label>
        <div className={`rounded-lg px-3 py-2 text-sm min-h-[3rem] ${
          box.source_text ? "bg-gray-800 text-gray-200" : "bg-gray-900 text-gray-600 italic"
        }`}>
          {box.source_text ?? "No OCR text"}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-gray-500">Translation</label>
        <div className={`rounded-lg px-3 py-2 text-sm min-h-[3rem] ${
          box.translated_text ? "bg-gray-800 text-gray-200" : "bg-gray-900 text-gray-600 italic"
        }`}>
          {box.translated_text ?? "No translation"}
        </div>
      </div>
    </div>
  );
}
