import { Loader2, RefreshCw, Wand2, FileImage, Pencil, Square, Eye, EyeOff } from "lucide-react";
import type { Stage } from "../stores/studio";

interface Props {
  stage: Stage;
  onStageChange: (s: Stage) => void;
  showBubbles: boolean;
  showTextSeg: boolean;
  isTextSegDrawMode: boolean;
  isRedetecting: boolean;
  isReocring: boolean;
  isTranslating: boolean;
  isInpainting: boolean;
  isBurning: boolean;
  onRedetect: () => void;
  onReocr: () => void;
  onTranslate: () => void;
  onInpaint: () => void;
  onBurn: () => void;
  onToggleBubbles: () => void;
  onToggleTextSeg: () => void;
  onToggleDrawMode: () => void;
}

const STAGES: { id: Stage; label: string }[] = [
  { id: "original", label: "Original" },
  { id: "textseg", label: "TextSeg" },
  { id: "inpainted", label: "Inpainted" },
  { id: "result", label: "Result" },
];

function ActionBtn({
  onClick, loading, disabled, icon: Icon, label, title,
}: {
  onClick: () => void; loading?: boolean; disabled?: boolean;
  icon: React.FC<{ size?: number }>; label: string; title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading || disabled}
      title={title ?? label}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
        bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed
        text-gray-200 transition-colors"
    >
      {loading ? <Loader2 size={13} className="animate-spin" /> : <Icon size={13} />}
      <span>{label}</span>
    </button>
  );
}

export function StudioToolbar(props: Props) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-gray-900 border-b border-gray-800 overflow-x-auto shrink-0">
      {/* Stage tabs */}
      <div className="flex gap-1 bg-gray-800 rounded-lg p-0.5 mr-2">
        {STAGES.map((s) => (
          <button
            key={s.id}
            onClick={() => props.onStageChange(s.id)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              props.stage === s.id
                ? "bg-indigo-600 text-white"
                : "text-gray-400 hover:text-white"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="h-5 w-px bg-gray-700" />

      {/* Visibility toggles */}
      <button
        onClick={props.onToggleTextSeg}
        title="Toggle TextSeg boxes"
        className={`p-1.5 rounded-lg text-xs transition-colors ${
          props.showTextSeg ? "text-emerald-400 bg-emerald-400/10" : "text-gray-500 hover:text-gray-300"
        }`}
      >
        <Square size={14} />
      </button>
      <button
        onClick={props.onToggleBubbles}
        title="Toggle bubble overlays"
        className={`p-1.5 rounded-lg text-xs transition-colors ${
          props.showBubbles ? "text-yellow-400 bg-yellow-400/10" : "text-gray-500 hover:text-gray-300"
        }`}
      >
        {props.showBubbles ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
      <button
        onClick={props.onToggleDrawMode}
        title="Draw TextSeg box (D)"
        className={`p-1.5 rounded-lg text-xs transition-colors ${
          props.isTextSegDrawMode ? "text-white bg-indigo-600" : "text-gray-500 hover:text-gray-300"
        }`}
      >
        <Pencil size={14} />
      </button>

      <div className="h-5 w-px bg-gray-700" />

      {/* Actions */}
      <ActionBtn onClick={props.onRedetect} loading={props.isRedetecting} icon={Wand2} label="Detect" />
      <ActionBtn onClick={props.onReocr} loading={props.isReocring} icon={FileImage} label="OCR" />
      <ActionBtn onClick={props.onTranslate} loading={props.isTranslating} icon={RefreshCw} label="Translate" />
      <ActionBtn onClick={props.onInpaint} loading={props.isInpainting} icon={RefreshCw} label="Inpaint"
        disabled={!props.showBubbles} title="Inpaint (not yet implemented)" />
      <ActionBtn onClick={props.onBurn} loading={props.isBurning} icon={FileImage} label="Render"
        title="Render (not yet implemented)" />
    </div>
  );
}
