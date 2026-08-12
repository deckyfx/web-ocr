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
  isTextSegDrawMode: boolean;
  /** Stage 3 bubble selection via canvas click. */
  onSelect: (idx: number | null) => void;
  onDrawTextSeg: (x: number, y: number, w: number, h: number) => void;
  onSelectTextSeg?: (index: number | null) => void;
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

  const stage1Props = () => ({
    bubbles: props.bubbleList,
    selectedIndex: props.selectedIndex,
    textSegDrawMode: props.isTextSegDrawMode,
    bubblePadding: props.bubblePadding,
    overlayBoxes: props.showTextSeg ? props.textSegBoxes : undefined,
    selectedTextSegIndex: props.showTextSeg ? props.selectedTextSegIndex : null,
    showBubbles: false,
    showTextOverlay: false,
    onDrawTextSeg: props.onDrawTextSeg,
    onSelectTextSeg: props.onSelectTextSeg,
  });

  const stage3Props = () => ({
    bubbles: props.bubbleList,
    selectedIndex: props.selectedIndex,
    bubblePadding: props.bubblePadding,
    showBubbles: props.showBubbles,
    onSelect: props.onSelect,
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
          imageUrl={inpaintedUrl()}
          imageWidth={props.job.originalWidth}
          imageHeight={props.job.originalHeight}
          showBubbles={false}
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
          imageUrl={resultUrl()}
          imageWidth={props.job.originalWidth}
          imageHeight={props.job.originalHeight}
          showBubbles={false}
        />
      ) : NoImagePlaceholder("No result image", "Run Burn Texts on Stage 3 first.");
  }
}
