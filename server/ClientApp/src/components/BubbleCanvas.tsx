import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { TranslationBubble } from "../types";
import type { TextSegBox } from "../api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DragNone = { kind: "none" };
type DragDrawingTextSeg = {
  kind: "drawing-textseg";
  startImgX: number;
  startImgY: number;
  curImgX: number;
  curImgY: number;
};
type DragState = DragNone | DragDrawingTextSeg;

interface Layout {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface BubbleCanvasProps {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  /** Bubble list — shown as display-only overlays (Stage 3 text preview). */
  bubbles?: TranslationBubble[];
  /** Highlighted bubble index (Stage 3 selection via left-panel list). */
  selectedIndex?: number | null;
  /** When true, draw a TextSeg block on next mousedown on the canvas background. */
  textSegDrawMode?: boolean;
  /** Additional display-only inset (px in image coords) applied on all sides. Default 0. */
  bubblePadding?: number;
  /**
   * When true, render the translated text as a floating overlay inside each
   * non-excluded bubble (Stage 3 compose view).
   */
  showTextOverlay?: boolean;
  /** Called when a bubble rect is clicked — for Stage 3 overlay selection. */
  onSelect?: (index: number | null) => void;
  /** Called when a TextSeg box is drawn on the canvas. */
  onDrawTextSeg?: (x: number, y: number, w: number, h: number) => void;
  /**
   * Optional TextSeg text-block boxes shown as a dashed orange overlay.
   * Rendered beneath the bubble rects so they don't interfere with pointer events.
   */
  overlayBoxes?: TextSegBox[];
  /** Index into overlayBoxes that is currently selected (highlighted in the sidebar). */
  selectedTextSegIndex?: number | null;
  /** When false, bubble bounding boxes are hidden. Default true. */
  showBubbles?: boolean;
  /** Called when a TextSeg overlay box is clicked. */
  onSelectTextSeg?: (index: number | null) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BubbleCanvas(props: BubbleCanvasProps): JSX.Element {
  let containerRef!: HTMLDivElement;
  let svgRef!: SVGSVGElement;

  const [layout, setLayout] = createSignal<Layout>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [drag, setDrag] = createSignal<DragState>({ kind: "none" });

  // ---------------------------------------------------------------------------
  // Coordinate math
  // ---------------------------------------------------------------------------

  function computeLayout(): void {
    if (!containerRef || !props.imageWidth || !props.imageHeight) return;
    const cW = containerRef.clientWidth;
    const cH = containerRef.clientHeight;
    if (cW === 0 || cH === 0) return;
    const scaleX = cW / props.imageWidth;
    const scaleY = cH / props.imageHeight;
    const scale = Math.min(scaleX, scaleY);
    const renderedW = props.imageWidth * scale;
    const renderedH = props.imageHeight * scale;
    setLayout({
      scale,
      offsetX: (cW - renderedW) / 2,
      offsetY: (cH - renderedH) / 2,
    });
  }

  function toSvg(imgX: number, imgY: number): { x: number; y: number } {
    const { scale, offsetX, offsetY } = layout();
    return { x: imgX * scale + offsetX, y: imgY * scale + offsetY };
  }

  function toImg(svgX: number, svgY: number): { x: number; y: number } {
    const { scale, offsetX, offsetY } = layout();
    if (scale === 0) return { x: 0, y: 0 };
    return { x: (svgX - offsetX) / scale, y: (svgY - offsetY) / scale };
  }

  function getMouseImgPos(e: MouseEvent): { x: number; y: number } {
    const rect = svgRef.getBoundingClientRect();
    return toImg(e.clientX - rect.left, e.clientY - rect.top);
  }

  function computeSvgBubbleRect(bubble: TranslationBubble): { x: number; y: number; w: number; h: number } {
    const pad = props.bubblePadding ?? 0;
    const tl = toSvg(bubble.bubbleX + pad, bubble.bubbleY + pad);
    const br = toSvg(bubble.bubbleX + bubble.bubbleW - pad, bubble.bubbleY + bubble.bubbleH - pad);
    return { x: tl.x, y: tl.y, w: Math.max(0, br.x - tl.x), h: Math.max(0, br.y - tl.y) };
  }

  // ---------------------------------------------------------------------------
  // Drag handlers (TextSeg draw only)
  // ---------------------------------------------------------------------------

  function onWindowMouseMove(e: MouseEvent): void {
    const d = drag();
    if (d.kind === "none") return;
    e.preventDefault();
    const pos = getMouseImgPos(e);
    setDrag({ ...d, curImgX: pos.x, curImgY: pos.y });
  }

  function commitAndStop(): void {
    const d = drag();
    if (d.kind === "drawing-textseg") {
      const x = Math.min(d.startImgX, d.curImgX);
      const y = Math.min(d.startImgY, d.curImgY);
      const w = Math.abs(d.curImgX - d.startImgX);
      const h = Math.abs(d.curImgY - d.startImgY);
      if (w > 5 && h > 5) {
        props.onDrawTextSeg?.(x, y, w, h);
      }
    }
    setDrag({ kind: "none" });
    window.removeEventListener("mousemove", onWindowMouseMove);
    window.removeEventListener("mouseup", onWindowMouseUp);
  }

  function onWindowMouseUp(e: MouseEvent): void {
    e.preventDefault();
    commitAndStop();
  }

  function beginDrag(): void {
    window.addEventListener("mousemove", onWindowMouseMove);
    window.addEventListener("mouseup", onWindowMouseUp);
  }

  // ---------------------------------------------------------------------------
  // SVG event handlers
  // ---------------------------------------------------------------------------

  function handleSvgMouseDown(e: MouseEvent): void {
    e.preventDefault();
    if (props.textSegDrawMode) {
      const pos = getMouseImgPos(e);
      setDrag({ kind: "drawing-textseg", startImgX: pos.x, startImgY: pos.y, curImgX: pos.x, curImgY: pos.y });
      beginDrag();
      return;
    }
    props.onSelect?.(null);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onMount(() => {
    computeLayout();
    const ro = new ResizeObserver(() => computeLayout());
    ro.observe(containerRef);
    onCleanup(() => {
      ro.disconnect();
      window.removeEventListener("mousemove", onWindowMouseMove);
      window.removeEventListener("mouseup", onWindowMouseUp);
    });
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const svgCursor = () => {
    const d = drag();
    if (d.kind === "drawing-textseg" || props.textSegDrawMode) return "crosshair";
    return "default";
  };

  const getTextSegDrawPreview = () => {
    const d = drag();
    if (d.kind !== "drawing-textseg") return null;
    return {
      x: Math.min(d.startImgX, d.curImgX),
      y: Math.min(d.startImgY, d.curImgY),
      w: Math.abs(d.curImgX - d.startImgX),
      h: Math.abs(d.curImgY - d.startImgY),
    };
  };

  return (
    <div ref={containerRef} class="relative overflow-hidden bg-slate-900 w-full h-full select-none">
      <img
        src={props.imageUrl}
        alt="manga page"
        class="w-full h-full object-contain pointer-events-none"
        draggable={false}
        onLoad={computeLayout}
      />
      <svg
        ref={svgRef}
        class="absolute inset-0 w-full h-full"
        style={{ cursor: svgCursor() }}
        onMouseDown={handleSvgMouseDown}
      >
        {/* TextSeg text-block overlay — always interactive when handler provided */}
        <Show when={(props.overlayBoxes?.length ?? 0) > 0}>
          <For each={props.overlayBoxes}>
            {(box, i) => {
              const tl = () => toSvg(box.x,         box.y);
              const br = () => toSvg(box.x + box.w, box.y + box.h);
              const isSelected = () => props.selectedTextSegIndex === i();
              const isInteractive = () => !!props.onSelectTextSeg;
              return (
                <rect
                  x={tl().x}
                  y={tl().y}
                  width={Math.max(0, br().x - tl().x)}
                  height={Math.max(0, br().y - tl().y)}
                  fill={isSelected() ? "rgba(255,120,0,0.18)" : "rgba(255,120,0,0.07)"}
                  stroke={isSelected() ? "#ea6800" : "#f97316"}
                  stroke-width={isSelected() ? "2.5" : "1.5"}
                  stroke-dasharray="5,3"
                  style={{ cursor: isInteractive() ? "pointer" : "none", "pointer-events": isInteractive() ? "auto" : "none" }}
                  onMouseDown={(e) => {
                    if (!isInteractive()) return;
                    e.preventDefault();
                    e.stopPropagation();
                    props.onSelectTextSeg!(isSelected() ? null : i());
                  }}
                />
              );
            }}
          </For>
        </Show>

        {/* Bubble display overlay — click-only, no drag/resize (Stage 3 text preview) */}
        <Show when={props.showBubbles !== false && (props.bubbles?.length ?? 0) > 0}>
          <For each={props.bubbles}>
            {(bubble) => {
              const svgRect = () => computeSvgBubbleRect(bubble);
              const isSelected = () => props.selectedIndex === bubble.bubbleIndex;

              const outlineColor = () => {
                if (bubble.isExcluded) return "#9ca3af";
                if (isSelected()) return "#7c3aed";
                return "#3b82f6";
              };
              const fillColor = () => {
                if (bubble.isExcluded) return "rgba(0,0,0,0.15)";
                if (isSelected()) return "rgba(124,58,237,0.1)";
                return "rgba(59,130,246,0.05)";
              };

              return (
                <g>
                  <rect
                    x={svgRect().x}
                    y={svgRect().y}
                    width={svgRect().w}
                    height={svgRect().h}
                    fill={fillColor()}
                    stroke={outlineColor()}
                    stroke-width={isSelected() ? 3 : 2}
                    style={{ cursor: "pointer" }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      props.onSelect?.(isSelected() ? null : bubble.bubbleIndex);
                    }}
                  />

                  <Show when={bubble.isExcluded}>
                    <line
                      x1={svgRect().x}
                      y1={svgRect().y}
                      x2={svgRect().x + svgRect().w}
                      y2={svgRect().y + svgRect().h}
                      stroke="#9ca3af"
                      stroke-width="1"
                      style={{ "pointer-events": "none" }}
                    />
                  </Show>

                  <text
                    x={svgRect().x + 3}
                    y={svgRect().y + 12}
                    font-size="10"
                    fill="white"
                    style={{ "pointer-events": "none", "user-select": "none" }}
                  >
                    {bubble.bubbleIndex}
                  </text>

                  {/* Text overlay (Stage 3 compose preview) */}
                  <Show when={props.showTextOverlay && !bubble.isExcluded && !!bubble.translatedText}>
                    <foreignObject
                      x={svgRect().x}
                      y={svgRect().y}
                      width={svgRect().w}
                      height={svgRect().h}
                      style={{ "pointer-events": "none" }}
                    >
                      <div
                        style={{
                          width: "100%",
                          height: "100%",
                          display: "flex",
                          "align-items": "center",
                          "justify-content": "center",
                          overflow: "hidden",
                          "box-sizing": "border-box",
                          padding: "3px",
                          "pointer-events": "none",
                        }}
                      >
                        <span
                          style={{
                            "font-family": bubble.fontFamily || "sans-serif",
                            "font-size": bubble.fontSizeOverride
                              ? `${bubble.fontSizeOverride * layout().scale}px`
                              : `${Math.max(8, Math.min(14, svgRect().h / 5))}px`,
                            "font-weight": "bold",
                            color: bubble.fontColor ?? "#1a1a1a",
                            "text-align": (bubble.textAlign ?? "center") as "left" | "center" | "right",
                            "-webkit-text-stroke":
                              bubble.strokeWidth && bubble.strokeWidth > 0
                                ? `${bubble.strokeWidth * layout().scale}px ${bubble.strokeColor ?? "#ffffff"}`
                                : undefined,
                            "word-break": "break-word",
                            "white-space": "pre-wrap",
                            "line-height": "1.25",
                            width: "100%",
                            display: "block",
                            "pointer-events": "none",
                          }}
                        >
                          {bubble.translatedText}
                        </span>
                      </div>
                    </foreignObject>
                  </Show>
                </g>
              );
            }}
          </For>
        </Show>

        {/* TextSeg draw-mode preview rect */}
        <Show when={getTextSegDrawPreview()}>
          {(dr) => {
            const svgDr = () => {
              const r = dr();
              const tl = toSvg(r.x, r.y);
              const br = toSvg(r.x + r.w, r.y + r.h);
              return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
            };
            return (
              <rect
                x={svgDr().x}
                y={svgDr().y}
                width={svgDr().w}
                height={svgDr().h}
                fill="rgba(249,115,22,0.1)"
                stroke="#f97316"
                stroke-width="2"
                stroke-dasharray="5,3"
                style={{ "pointer-events": "none" }}
              />
            );
          }}
        </Show>
      </svg>
    </div>
  );
}
