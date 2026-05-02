import { useEffect, useRef, useState } from "react";
import { useRustIPC, useRustEventListener } from "@deckyfx/dioxus-react-bridge";
import { OcrResult } from "./components/OcrResult";
import { TokenList } from "./components/TokenList";
import { StatusBar } from "./components/StatusBar";
import type { Token, Definition } from "./components/TokenCard";

type AppStatus = "idle" | "capturing" | "selecting" | "analyzing" | "error";

type ResultData = {
  ocr_text: string;
  translation?: string;
  tokens: Token[];
  definitions: Definition[];
  elapsed_ms: number;
};

type DragState = {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  dragging: boolean;
};

export function App() {
  const { fetch: rustFetch } = useRustIPC();
  const [status, setStatus] = useState<AppStatus>("idle");
  const [error, setError] = useState<string>();
  const [screenshot, setScreenshot] = useState<string>();
  const [result, setResult] = useState<ResultData>();
  const [naturalSize, setNaturalSize] = useState({ w: 1, h: 1 });

  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [selection, setSelection] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // ── IPC event listeners ───────────────────────────────────────────────────

  const captureStart = useRustEventListener("capture/start");
  const captureScreenshot = useRustEventListener("capture/screenshot") as { image: string } | null;
  const captureResult = useRustEventListener("capture/result") as ResultData | null;
  const captureError = useRustEventListener("capture/error") as { message: string } | null;

  useEffect(() => {
    if (captureStart !== null) {
      setStatus("capturing");
      setScreenshot(undefined);
      setSelection(null);
      setResult(undefined);
    }
  }, [captureStart]);

  useEffect(() => {
    if (captureScreenshot) {
      setScreenshot(captureScreenshot.image);
      setStatus("selecting");
    }
  }, [captureScreenshot]);

  useEffect(() => {
    if (captureResult) {
      setResult(captureResult);
      setScreenshot(undefined);
      setStatus("idle");
    }
  }, [captureResult]);

  useEffect(() => {
    if (captureError) {
      setError(captureError.message);
      setStatus("error");
      setScreenshot(undefined);
    }
  }, [captureError]);

  // ── Selection canvas helpers ──────────────────────────────────────────────

  const getScaleFactor = () => {
    if (!imgRef.current) return { scaleX: 1, scaleY: 1 };
    const rect = imgRef.current.getBoundingClientRect();
    return {
      scaleX: naturalSize.w / rect.width,
      scaleY: naturalSize.h / rect.height,
    };
  };

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (status !== "selecting") return;
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      endX: e.clientX - rect.left,
      endY: e.clientY - rect.top,
      dragging: true,
    };
    setSelection(null);
  };

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current?.dragging) return;
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current.endX = e.clientX - rect.left;
    dragRef.current.endY = e.clientY - rect.top;
    const { startX, startY, endX, endY } = dragRef.current;
    setSelection({
      x: Math.min(startX, endX),
      y: Math.min(startY, endY),
      w: Math.abs(endX - startX),
      h: Math.abs(endY - startY),
    });
  };

  const onMouseUp = async () => {
    if (!dragRef.current?.dragging || !selection || selection.w < 4 || selection.h < 4) {
      dragRef.current = null;
      return;
    }
    dragRef.current.dragging = false;

    const { scaleX, scaleY } = getScaleFactor();
    const crop = {
      x: Math.round(selection.x * scaleX),
      y: Math.round(selection.y * scaleY),
      width: Math.round(selection.w * scaleX),
      height: Math.round(selection.h * scaleY),
    };

    setStatus("analyzing");
    setScreenshot(undefined);
    setSelection(null);

    try {
      await rustFetch("/capture/crop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(crop),
      });
    } catch (err) {
      setError(String(err));
      setStatus("error");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && status === "selecting") {
      setStatus("idle");
      setScreenshot(undefined);
      setSelection(null);
      dragRef.current = null;
      rustFetch("/capture/cancel", { method: "POST" }).catch(() => {});
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  // Full-screen selection mode
  if (status === "selecting" && screenshot) {
    return (
      <div
        className="fixed inset-0 overflow-hidden select-none"
        style={{ cursor: "crosshair" }}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
      >
        <img
          ref={imgRef}
          src={screenshot}
          alt="screenshot"
          className="absolute inset-0 w-full h-full object-contain"
          draggable={false}
          onLoad={() => {
            if (imgRef.current) {
              setNaturalSize({
                w: imgRef.current.naturalWidth,
                h: imgRef.current.naturalHeight,
              });
            }
          }}
        />
        {/* Dim overlay */}
        <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.45)", pointerEvents: "none" }} />

        {/* Selection rect */}
        {selection && selection.w > 2 && selection.h > 2 && (
          <div
            className="absolute pointer-events-none"
            style={{
              left: selection.x,
              top: selection.y,
              width: selection.w,
              height: selection.h,
              border: "2px solid rgba(255,255,255,0.9)",
              background: "transparent",
              boxSizing: "border-box",
            }}
          />
        )}

        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none text-white text-sm px-4 py-2 rounded-lg"
          style={{ background: "rgba(0,0,0,0.7)", whiteSpace: "nowrap" }}
        >
          {selection && selection.w > 2 ? `${Math.round(selection.w)} × ${Math.round(selection.h)}` : "Drag to select a region · Esc to cancel"}
        </div>
      </div>
    );
  }

  // Result / status panel
  return (
    <div className="flex flex-col h-screen bg-[var(--base)]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--surface1)] shrink-0">
        <span className="font-semibold text-[var(--text)] text-sm">Web OCR</span>

        <div className="flex items-center gap-2">
          {/* Capture button — always visible unless already in progress */}
          {(status === "idle" || status === "error") && (
            <button
              className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium bg-[var(--blue)] text-[var(--base)] hover:opacity-90 transition-opacity"
              onClick={async () => {
                try {
                  const res = await rustFetch("/capture/start", { method: "POST" });
                  console.log("[capture/start] response:", res);
                } catch (err) {
                  console.error("[capture/start] error:", err);
                  setError(String(err));
                  setStatus("error");
                }
              }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h3A1.5 1.5 0 0 1 7 2.5V3h2v-.5A1.5 1.5 0 0 1 10.5 1h3A1.5 1.5 0 0 1 15 2.5v3A1.5 1.5 0 0 1 13.5 7H13v2h.5A1.5 1.5 0 0 1 15 10.5v3A1.5 1.5 0 0 1 13.5 15h-3A1.5 1.5 0 0 1 9 13.5V13H7v.5A1.5 1.5 0 0 1 5.5 15h-3A1.5 1.5 0 0 1 1 13.5v-3A1.5 1.5 0 0 1 2.5 9H3V7h-.5A1.5 1.5 0 0 1 1 5.5v-3z"/>
              </svg>
              Capture
            </button>
          )}

          {result && (
            <button
              className="text-xs text-[var(--overlay0)] hover:text-[var(--text)] transition-colors"
              onClick={() => { setResult(undefined); setStatus("idle"); }}
            >
              Clear
            </button>
          )}
          {status === "error" && (
            <button
              className="text-xs text-[var(--overlay0)] hover:text-[var(--text)] transition-colors"
              onClick={() => { setError(undefined); setStatus("idle"); }}
            >
              Dismiss
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {!result && (status === "idle" || status === "capturing" || status === "analyzing" || status === "error") && (
          <StatusBar status={status} error={error} />
        )}

        {result && (
          <>
            <OcrResult text={result.ocr_text} translation={result.translation} />
            <TokenList tokens={result.tokens} definitions={result.definitions} />
            <div className="px-4 pb-3 text-right text-[10px] text-[var(--surface2)]">
              {result.elapsed_ms}ms
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
