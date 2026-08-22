import { useRef, useState, useCallback } from "react";
import type { TextSegBlock, TranslationBubble } from "../types";

interface Props {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  bubbles?: TranslationBubble[];
  selectedBubbleIndex?: number | null;
  overlayBoxes?: TextSegBlock[];
  selectedTextSegIndex?: number | null;
  textSegDrawMode?: boolean;
  showBubbles?: boolean;
  showTextOverlay?: boolean;
  bubblePadding?: number;
  onSelectBubble?: (index: number | null) => void;
  onSelectTextSeg?: (index: number | null) => void;
  onDrawTextSeg?: (x: number, y: number, w: number, h: number) => void;
  onImageLoad?: (w: number, h: number) => void;
}

interface DrawState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

export function BubbleCanvas({
  imageUrl,
  imageWidth,
  imageHeight,
  bubbles = [],
  selectedBubbleIndex,
  overlayBoxes = [],
  selectedTextSegIndex,
  textSegDrawMode,
  showBubbles = true,
  showTextOverlay,
  bubblePadding = 0,
  onSelectBubble,
  onSelectTextSeg,
  onDrawTextSeg,
  onImageLoad,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [drawState, setDrawState] = useState<DrawState | null>(null);

  const getRelativePos = useCallback((e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const scaleX = imageWidth / rect.width;
    const scaleY = imageHeight / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, [imageWidth, imageHeight]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!textSegDrawMode) return;
    e.preventDefault();
    const pos = getRelativePos(e);
    setDrawState({ startX: pos.x, startY: pos.y, currentX: pos.x, currentY: pos.y });
  }, [textSegDrawMode, getRelativePos]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!drawState) return;
    const pos = getRelativePos(e);
    setDrawState((prev) => prev ? { ...prev, currentX: pos.x, currentY: pos.y } : null);
  }, [drawState, getRelativePos]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!drawState || !onDrawTextSeg) return;
    const x = Math.min(drawState.startX, drawState.currentX);
    const y = Math.min(drawState.startY, drawState.currentY);
    const w = Math.abs(drawState.currentX - drawState.startX);
    const h = Math.abs(drawState.currentY - drawState.startY);
    if (w > 4 && h > 4) onDrawTextSeg(x, y, w, h);
    setDrawState(null);
  }, [drawState, onDrawTextSeg]);

  const scaleX = (v: number) => `${(v / imageWidth) * 100}%`;
  const scaleY = (v: number) => `${(v / imageHeight) * 100}%`;
  const scaleW = (v: number) => `${(v / imageWidth) * 100}%`;
  const scaleH = (v: number) => `${(v / imageHeight) * 100}%`;

  return (
    <div
      ref={containerRef}
      className={`relative w-full select-none ${textSegDrawMode ? "cursor-crosshair" : "cursor-default"}`}
      style={{ aspectRatio: `${imageWidth}/${imageHeight}` }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => drawState && setDrawState(null)}
    >
      <img
        src={imageUrl}
        alt=""
        className="absolute inset-0 w-full h-full object-contain pointer-events-none"
        draggable={false}
        onLoad={(e) => {
          const img = e.currentTarget;
          onImageLoad?.(img.naturalWidth, img.naturalHeight);
        }}
      />

      {/* Bubble overlays */}
      {showBubbles && bubbles.map((b, i) => {
        const pad = bubblePadding;
        const isSelected = i === selectedBubbleIndex;
        return (
          <div
            key={b.id}
            className={`absolute border-2 rounded transition-colors cursor-pointer ${
              isSelected ? "border-indigo-400 bg-indigo-400/10" : "border-yellow-400/60 hover:border-yellow-300"
            }`}
            style={{
              left: scaleX(b.x - pad),
              top: scaleY(b.y - pad),
              width: scaleW(b.width + pad * 2),
              height: scaleH(b.height + pad * 2),
              transform: b.rotation ? `rotate(${b.rotation}deg)` : undefined,
            }}
            onClick={(e) => { e.stopPropagation(); onSelectBubble?.(i === selectedBubbleIndex ? null : i); }}
          >
            {showTextOverlay && b.translatedText && (
              <div className="absolute inset-0 flex items-center justify-center p-1 overflow-hidden">
                <span className="text-white text-center text-xs leading-tight font-medium drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
                  {b.translatedText}
                </span>
              </div>
            )}
          </div>
        );
      })}

      {/* TextSeg overlays */}
      {overlayBoxes.map((box, i) => {
        const isSelected = i === selectedTextSegIndex;
        return (
          <div
            key={box.id}
            className={`absolute border-2 rounded transition-colors ${
              onSelectTextSeg ? "cursor-pointer" : ""
            } ${isSelected ? "border-emerald-400 bg-emerald-400/10" : "border-emerald-500/60 hover:border-emerald-400"}`}
            style={{
              left: scaleX(box.x),
              top: scaleY(box.y),
              width: scaleW(box.w),
              height: scaleH(box.h),
            }}
            onClick={(e) => {
              e.stopPropagation();
              onSelectTextSeg?.(i === selectedTextSegIndex ? null : i);
            }}
          />
        );
      })}

      {/* Draw preview */}
      {drawState && (() => {
        const x = Math.min(drawState.startX, drawState.currentX);
        const y = Math.min(drawState.startY, drawState.currentY);
        const w = Math.abs(drawState.currentX - drawState.startX);
        const h = Math.abs(drawState.currentY - drawState.startY);
        return (
          <div
            className="absolute border-2 border-dashed border-emerald-400 bg-emerald-400/10 pointer-events-none"
            style={{ left: scaleX(x), top: scaleY(y), width: scaleW(w), height: scaleH(h) }}
          />
        );
      })()}
    </div>
  );
}
