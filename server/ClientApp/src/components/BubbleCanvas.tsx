import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { TranslationBubble } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ResizeHandle = "TL" | "T" | "TR" | "L" | "R" | "BL" | "B" | "BR";

type DragNone = { kind: "none" };
type DragMoving = {
  kind: "moving";
  bubbleIndex: number;
  startImgX: number;
  startImgY: number;
  curImgX: number;
  curImgY: number;
};
type DragResizing = {
  kind: "resizing";
  bubbleIndex: number;
  handle: ResizeHandle;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
  startImgX: number;
  startImgY: number;
  curImgX: number;
  curImgY: number;
};
type DragDrawing = {
  kind: "drawing";
  startImgX: number;
  startImgY: number;
  curImgX: number;
  curImgY: number;
};
/** Rotation drag: tracks angle in degrees during a rotation handle gesture. */
type DragRotating = {
  kind: "rotating";
  bubbleIndex: number;
  /** Center of the bounding box in SVG-viewport coordinates (fixed for the gesture). */
  centerSvgX: number;
  centerSvgY: number;
  /** Mouse angle at drag-start (degrees, atan2 in SVG space). */
  startAngle: number;
  /** Bubble rotation at drag-start. */
  initialRotation: number;
  /** Live rotation updated on each mousemove. */
  currentRotation: number;
};
type DragState = DragNone | DragMoving | DragResizing | DragDrawing | DragRotating;

interface Layout {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface BubbleCanvasProps {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  bubbles: TranslationBubble[];
  selectedIndex: number | null;
  /** When true the next mousedown on the canvas background starts a draw gesture. */
  drawMode?: boolean;
  /** Additional display-only inset (px in image coords) applied on all sides. Default 0. */
  bubblePadding?: number;
  /**
   * When true, render the translated text as a floating overlay inside each
   * non-excluded bubble and show the rotation handle on the selected bubble.
   */
  showTextOverlay?: boolean;
  onSelect: (index: number | null) => void;
  onMove: (bubbleIndex: number, dx: number, dy: number) => void;
  onResize: (bubbleIndex: number, x: number, y: number, w: number, h: number) => void;
  onDraw: (x: number, y: number, w: number, h: number) => void;
  /** Called when the rotation handle is dragged; degrees, not normalised. Stage 3 only. */
  onRotate?: (bubbleIndex: number, rotation: number) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HANDLES: ResizeHandle[] = ["TL", "T", "TR", "L", "R", "BL", "B", "BR"];

const HANDLE_OFFSETS: Record<ResizeHandle, [number, number]> = {
  TL: [0, 0],
  T: [0.5, 0],
  TR: [1, 0],
  L: [0, 0.5],
  R: [1, 0.5],
  BL: [0, 1],
  B: [0.5, 1],
  BR: [1, 1],
};

const HANDLE_CURSORS: Record<ResizeHandle, string> = {
  TL: "nw-resize",
  T: "n-resize",
  TR: "ne-resize",
  L: "w-resize",
  R: "e-resize",
  BL: "sw-resize",
  B: "s-resize",
  BR: "se-resize",
};

/** Pixels above the top-centre of the bounding box where the rotation handle sits. */
const ROTATION_HANDLE_OFFSET = 24;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyResize(
  handle: ResizeHandle,
  orig: { x: number; y: number; w: number; h: number },
  dx: number,
  dy: number,
): { x: number; y: number; w: number; h: number } {
  let { x, y, w, h } = orig;
  switch (handle) {
    case "TL": x += dx; y += dy; w -= dx; h -= dy; break;
    case "T":  y += dy; h -= dy; break;
    case "TR": y += dy; w += dx; h -= dy; break;
    case "L":  x += dx; w -= dx; break;
    case "R":  w += dx; break;
    case "BL": x += dx; w -= dx; h += dy; break;
    case "B":  h += dy; break;
    case "BR": w += dx; h += dy; break;
  }
  if (w < 5) w = 5;
  if (h < 5) h = 5;
  return { x, y, w, h };
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

  function getMouseSvgPos(e: MouseEvent): { x: number; y: number } {
    const rect = svgRef.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ---------------------------------------------------------------------------
  // Bubble rect helpers
  // ---------------------------------------------------------------------------

  function getBubbleRect(bubble: TranslationBubble): { x: number; y: number; w: number; h: number } {
    const d = drag();
    if (d.kind === "moving" && d.bubbleIndex === bubble.bubbleIndex) {
      return {
        x: bubble.bubbleX + (d.curImgX - d.startImgX),
        y: bubble.bubbleY + (d.curImgY - d.startImgY),
        w: bubble.bubbleW,
        h: bubble.bubbleH,
      };
    }
    if (d.kind === "resizing" && d.bubbleIndex === bubble.bubbleIndex) {
      return applyResize(
        d.handle,
        { x: d.origX, y: d.origY, w: d.origW, h: d.origH },
        d.curImgX - d.startImgX,
        d.curImgY - d.startImgY,
      );
    }
    return { x: bubble.bubbleX, y: bubble.bubbleY, w: bubble.bubbleW, h: bubble.bubbleH };
  }

  function computeSvgRect(bubble: TranslationBubble): { x: number; y: number; w: number; h: number } {
    const r = getBubbleRect(bubble);
    const pad = props.bubblePadding ?? 0;
    const tl = toSvg(r.x + pad, r.y + pad);
    const br = toSvg(r.x + r.w - pad, r.y + r.h - pad);
    return { x: tl.x, y: tl.y, w: Math.max(0, br.x - tl.x), h: Math.max(0, br.y - tl.y) };
  }

  function getBubbleRotation(bubble: TranslationBubble): number {
    const d = drag();
    if (d.kind === "rotating" && d.bubbleIndex === bubble.bubbleIndex) {
      return d.currentRotation;
    }
    return bubble.rotation ?? 0;
  }

  function getDrawPreview(): { x: number; y: number; w: number; h: number } | null {
    const d = drag();
    if (d.kind !== "drawing") return null;
    return {
      x: Math.min(d.startImgX, d.curImgX),
      y: Math.min(d.startImgY, d.curImgY),
      w: Math.abs(d.curImgX - d.startImgX),
      h: Math.abs(d.curImgY - d.startImgY),
    };
  }

  // ---------------------------------------------------------------------------
  // Global drag handlers
  // ---------------------------------------------------------------------------

  function onWindowMouseMove(e: MouseEvent): void {
    const d = drag();
    if (d.kind === "none") return;
    e.preventDefault();
    if (d.kind === "rotating") {
      const svgPos = getMouseSvgPos(e);
      const angle =
        Math.atan2(svgPos.y - d.centerSvgY, svgPos.x - d.centerSvgX) * (180 / Math.PI);
      setDrag({ ...d, currentRotation: d.initialRotation + (angle - d.startAngle) });
    } else {
      const pos = getMouseImgPos(e);
      if (d.kind === "moving") {
        setDrag({ ...d, curImgX: pos.x, curImgY: pos.y });
      } else if (d.kind === "resizing") {
        setDrag({ ...d, curImgX: pos.x, curImgY: pos.y });
      } else if (d.kind === "drawing") {
        setDrag({ ...d, curImgX: pos.x, curImgY: pos.y });
      }
    }
  }

  function commitAndStop(): void {
    const d = drag();
    if (d.kind === "moving") {
      const dx = d.curImgX - d.startImgX;
      const dy = d.curImgY - d.startImgY;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        props.onMove(d.bubbleIndex, dx, dy);
      }
    } else if (d.kind === "resizing") {
      const r = applyResize(
        d.handle,
        { x: d.origX, y: d.origY, w: d.origW, h: d.origH },
        d.curImgX - d.startImgX,
        d.curImgY - d.startImgY,
      );
      props.onResize(d.bubbleIndex, r.x, r.y, r.w, r.h);
    } else if (d.kind === "drawing") {
      const x = Math.min(d.startImgX, d.curImgX);
      const y = Math.min(d.startImgY, d.curImgY);
      const w = Math.abs(d.curImgX - d.startImgX);
      const h = Math.abs(d.curImgY - d.startImgY);
      if (w > 5 && h > 5) {
        props.onDraw(x, y, w, h);
      } else {
        props.onSelect(null);
      }
    } else if (d.kind === "rotating") {
      props.onRotate?.(d.bubbleIndex, d.currentRotation);
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
    if (!props.drawMode) {
      props.onSelect(null);
      return;
    }
    const pos = getMouseImgPos(e);
    setDrag({ kind: "drawing", startImgX: pos.x, startImgY: pos.y, curImgX: pos.x, curImgY: pos.y });
    beginDrag();
  }

  function handleBubbleMouseDown(e: MouseEvent, bubble: TranslationBubble): void {
    e.preventDefault();
    e.stopPropagation();
    props.onSelect(bubble.bubbleIndex);
    const pos = getMouseImgPos(e);
    setDrag({
      kind: "moving",
      bubbleIndex: bubble.bubbleIndex,
      startImgX: pos.x,
      startImgY: pos.y,
      curImgX: pos.x,
      curImgY: pos.y,
    });
    beginDrag();
  }

  function handleHandleMouseDown(e: MouseEvent, bubble: TranslationBubble, handle: ResizeHandle): void {
    e.preventDefault();
    e.stopPropagation();
    const pos = getMouseImgPos(e);
    setDrag({
      kind: "resizing",
      bubbleIndex: bubble.bubbleIndex,
      handle,
      origX: bubble.bubbleX,
      origY: bubble.bubbleY,
      origW: bubble.bubbleW,
      origH: bubble.bubbleH,
      startImgX: pos.x,
      startImgY: pos.y,
      curImgX: pos.x,
      curImgY: pos.y,
    });
    beginDrag();
  }

  function handleRotateMouseDown(e: MouseEvent, bubble: TranslationBubble): void {
    e.preventDefault();
    e.stopPropagation();
    const sr = computeSvgRect(bubble);
    const cx = sr.x + sr.w / 2;
    const cy = sr.y + sr.h / 2;
    const svgPos = getMouseSvgPos(e);
    const startAngle =
      Math.atan2(svgPos.y - cy, svgPos.x - cx) * (180 / Math.PI);
    setDrag({
      kind: "rotating",
      bubbleIndex: bubble.bubbleIndex,
      centerSvgX: cx,
      centerSvgY: cy,
      startAngle,
      initialRotation: bubble.rotation ?? 0,
      currentRotation: bubble.rotation ?? 0,
    });
    beginDrag();
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
    if (d.kind === "moving" || d.kind === "rotating") return "grabbing";
    if (d.kind === "drawing" || props.drawMode) return "crosshair";
    return "default";
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
        <For each={props.bubbles}>
          {(bubble) => {
            const svgRect = () => computeSvgRect(bubble);
            const cx = () => svgRect().x + svgRect().w / 2;
            const cy = () => svgRect().y + svgRect().h / 2;
            const rotation = () => getBubbleRotation(bubble);

            const isSelected = () => props.selectedIndex === bubble.bubbleIndex;

            const outlineColor = () => {
              if (bubble.isExcluded) return "#9ca3af";
              if (isSelected()) return "#7c3aed";
              if (bubble.isManuallyAdded) return "#10b981";
              return "#3b82f6";
            };
            const fillColor = () => {
              if (bubble.isExcluded) return "rgba(0,0,0,0.15)";
              if (isSelected()) return "rgba(124,58,237,0.1)";
              return "rgba(59,130,246,0.05)";
            };

            // SVG transform string — only applied in Stage 3 (showTextOverlay) mode
            const groupTransform = () =>
              props.showTextOverlay
                ? `rotate(${rotation()} ${cx()} ${cy()})`
                : undefined;

            return (
              // biome-ignore lint/a11y/useKeyWithMouseEvents: SVG canvas element
              <g transform={groupTransform()}>
                {/* Main bubble rect */}
                <rect
                  x={svgRect().x}
                  y={svgRect().y}
                  width={svgRect().w}
                  height={svgRect().h}
                  fill={fillColor()}
                  stroke={outlineColor()}
                  stroke-width={isSelected() ? 3 : 2}
                  style={{ cursor: "grab" }}
                  onMouseDown={(e) => handleBubbleMouseDown(e, bubble)}
                />

                {/* Excluded diagonal strikethrough */}
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

                {/* Index label (shadow) */}
                <text
                  x={svgRect().x + 4}
                  y={svgRect().y + 13}
                  font-size="10"
                  fill="black"
                  style={{ "pointer-events": "none", "user-select": "none" }}
                >
                  {bubble.bubbleIndex}
                </text>
                {/* Index label (foreground) */}
                <text
                  x={svgRect().x + 3}
                  y={svgRect().y + 12}
                  font-size="10"
                  fill="white"
                  style={{ "pointer-events": "none", "user-select": "none" }}
                >
                  {bubble.bubbleIndex}
                </text>

                {/* ── Resize handles (when selected) ── */}
                <Show when={isSelected()}>
                  <For each={HANDLES}>
                    {(handle) => {
                      const [fx, fy] = HANDLE_OFFSETS[handle];
                      const hx = () => svgRect().x + fx * svgRect().w;
                      const hy = () => svgRect().y + fy * svgRect().h;
                      return (
                        <rect
                          x={hx() - 4}
                          y={hy() - 4}
                          width={8}
                          height={8}
                          fill="white"
                          stroke="#7c3aed"
                          stroke-width="1.5"
                          style={{ cursor: HANDLE_CURSORS[handle] }}
                          onMouseDown={(e) => handleHandleMouseDown(e, bubble, handle)}
                        />
                      );
                    }}
                  </For>
                </Show>

                {/* ── Rotation handle (Stage 3, selected only) ── */}
                <Show when={props.showTextOverlay && isSelected()}>
                  {/* Stem line from top-centre up to handle */}
                  <line
                    x1={cx()}
                    y1={svgRect().y}
                    x2={cx()}
                    y2={svgRect().y - ROTATION_HANDLE_OFFSET + 5}
                    stroke="#7c3aed"
                    stroke-width="1.5"
                    stroke-dasharray="3,2"
                    style={{ "pointer-events": "none" }}
                  />
                  {/* Outer shadow circle */}
                  <circle
                    cx={cx()}
                    cy={svgRect().y - ROTATION_HANDLE_OFFSET}
                    r={6}
                    fill="rgba(0,0,0,0.18)"
                    style={{ "pointer-events": "none" }}
                  />
                  {/* Handle circle */}
                  <circle
                    cx={cx()}
                    cy={svgRect().y - ROTATION_HANDLE_OFFSET}
                    r={5}
                    fill="white"
                    stroke="#7c3aed"
                    stroke-width="1.5"
                    style={{ cursor: "grab" }}
                    onMouseDown={(e) => handleRotateMouseDown(e, bubble)}
                  />
                  {/* Rotation angle badge (shown only during active rotation drag) */}
                  <Show when={drag().kind === "rotating" && (drag() as DragRotating).bubbleIndex === bubble.bubbleIndex}>
                    <rect
                      x={cx() + 8}
                      y={svgRect().y - ROTATION_HANDLE_OFFSET - 8}
                      width={38}
                      height={16}
                      rx={3}
                      fill="rgba(124,58,237,0.9)"
                    />
                    <text
                      x={cx() + 27}
                      y={svgRect().y - ROTATION_HANDLE_OFFSET + 4}
                      font-size="10"
                      fill="white"
                      text-anchor="middle"
                      style={{ "pointer-events": "none", "user-select": "none" }}
                    >
                      {Math.round(rotation())}°
                    </text>
                  </Show>
                </Show>

                {/* ── Text overlay (Stage 3 preview) ── */}
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

        {/* Draw-mode preview rect */}
        <Show when={getDrawPreview()}>
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
                fill="rgba(16,185,129,0.1)"
                stroke="#10b981"
                stroke-width="2"
                stroke-dasharray="4,2"
                style={{ "pointer-events": "none" }}
              />
            );
          }}
        </Show>
      </svg>
    </div>
  );
}
