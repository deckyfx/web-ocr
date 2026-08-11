import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { ImageOff } from "lucide-solid";
import { BubbleCanvas } from "./BubbleCanvas";
import {
  jobInpaintedUrl,
  jobOriginalUrl,
  jobResultUrl,
} from "../api";
import type { TextSegBox } from "../api";
import type { PageTranslationJob, TranslationBubble } from "../types";
import type { Stage } from "./StudioToolbar";

interface StageViewProps {
  stage: Stage;
  jobId: string;
  job: PageTranslationJob;
  imageVersion: number;
  bubbleList: TranslationBubble[];
  selectedIndex: number | null;
  bubblePadding: number;
  showTextSeg: boolean;
  textSegBoxes: TextSegBox[];
  selectedTextSegIndex: number | null;
  showBubbles: boolean;
  isDrawMode: boolean;
  onSelect: (idx: number | null) => void;
  onMove: (bubbleIndex: number, dx: number, dy: number) => Promise<void>;
  onResize: (bubbleIndex: number, x: number, y: number, w: number, h: number) => Promise<void>;
  onDraw: (x: number, y: number, w: number, h: number) => void;
  onRotate?: (bubbleIndex: number, rotation: number) => Promise<void>;
}

const NoImagePlaceholder = (label: string, hint: string) => (
  <div class="flex flex-1 flex-col items-center justify-center gap-3 text-slate-400">
    <ImageOff class="h-10 w-10 opacity-40" />
    <p class="text-sm">{label}</p>
    <p class="text-xs">{hint}</p>
  </div>
);

export function StudioStageView(props: StageViewProps): JSX.Element {
  const v = () => props.imageVersion;
  const inpaintedUrl = () => `${jobInpaintedUrl(props.jobId)}?v=${v()}`;
  const resultUrl = () => `${jobResultUrl(props.jobId)}?v=${v()}`;

  const readOnlyProps = () => ({
    bubbles: props.bubbleList,
    selectedIndex: null as number | null,
    drawMode: false,
    bubblePadding: props.bubblePadding,
    onSelect: () => {},
    onMove: () => {},
    onResize: () => {},
    onDraw: () => {},
    showBubbles: props.showBubbles,
  });

  const stage1Props = () => ({
    bubbles: props.bubbleList,
    selectedIndex: props.selectedIndex,
    drawMode: props.isDrawMode,
    bubblePadding: props.bubblePadding,
    overlayBoxes: props.showTextSeg ? props.textSegBoxes : undefined,
    selectedTextSegIndex: props.showTextSeg ? props.selectedTextSegIndex : null,
    showBubbles: props.showBubbles,
    onSelect: props.onSelect,
    onMove: props.onMove,
    onResize: props.onResize,
    onDraw: props.onDraw,
    showTextOverlay: false,
  });

  const stage3Props = () => ({
    bubbles: props.bubbleList,
    selectedIndex: props.selectedIndex,
    drawMode: false,
    bubblePadding: props.bubblePadding,
    onSelect: props.onSelect,
    onMove: props.onMove,
    onResize: props.onResize,
    onDraw: () => {},
    onRotate: props.onRotate,
    showTextOverlay: true,
  });

  switch (props.stage) {
    case "original":
      return (
        <BubbleCanvas
          {...stage1Props()}
          imageUrl={jobOriginalUrl(props.jobId)}
          imageWidth={props.job.originalWidth}
          imageHeight={props.job.originalHeight}
        />
      );

    case "inpainted":
      return props.job.inpaintedImagePath ? (
        <BubbleCanvas
          {...readOnlyProps()}
          imageUrl={inpaintedUrl()}
          imageWidth={props.job.originalWidth}
          imageHeight={props.job.originalHeight}
        />
      ) : NoImagePlaceholder("No inpainted image", "Run Inpaint on Stage 1 first.");

    case "compose":
      return props.job.inpaintedImagePath ? (
        <BubbleCanvas
          {...stage3Props()}
          imageUrl={inpaintedUrl()}
          imageWidth={props.job.originalWidth}
          imageHeight={props.job.originalHeight}
        />
      ) : NoImagePlaceholder("No inpainted image", "Run Inpaint on Stage 1 first.");

    case "result":
      return props.job.resultImagePath ? (
        <BubbleCanvas
          {...readOnlyProps()}
          imageUrl={resultUrl()}
          imageWidth={props.job.originalWidth}
          imageHeight={props.job.originalHeight}
        />
      ) : NoImagePlaceholder("No result image", "Run Burn Texts on Stage 3 first.");
  }
}
