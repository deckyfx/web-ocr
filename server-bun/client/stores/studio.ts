import { create } from "zustand";
import type { PageTranslationJob, TextSegBlock, TranslationBubble } from "../types";

export type Stage = "original" | "textseg" | "inpainted" | "result";

interface StudioState {
  job: PageTranslationJob | null;
  bubbles: TranslationBubble[];
  textSegBlocks: TextSegBlock[];
  activeStage: Stage;
  selectedBubbleIndex: number | null;
  selectedTextSegIndex: number | null;
  isTextSegDrawMode: boolean;
  showBubbles: boolean;
  showTextSeg: boolean;
  bubblePadding: number;
  imageVersion: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;

  // loading flags
  isRedetecting: boolean;
  isReocring: boolean;
  isTranslating: boolean;
  isInpainting: boolean;
  isBurning: boolean;
  actionError: string | null;

  // actions
  setJob: (job: PageTranslationJob | null) => void;
  setBubbles: (bubbles: TranslationBubble[]) => void;
  setTextSegBlocks: (blocks: TextSegBlock[]) => void;
  setActiveStage: (stage: Stage) => void;
  selectBubble: (index: number | null) => void;
  selectTextSeg: (index: number | null) => void;
  setTextSegDrawMode: (v: boolean) => void;
  setShowBubbles: (v: boolean) => void;
  setShowTextSeg: (v: boolean) => void;
  setBubblePadding: (n: number) => void;
  bumpImageVersion: () => void;
  setLeftCollapsed: (v: boolean) => void;
  setRightCollapsed: (v: boolean) => void;
  setLoading: (flag: keyof Pick<StudioState, "isRedetecting" | "isReocring" | "isTranslating" | "isInpainting" | "isBurning">, v: boolean) => void;
  setActionError: (msg: string | null) => void;
  reset: () => void;
}

const storedPadding = () => {
  const v = parseInt(localStorage.getItem("studio-bubble-padding") ?? "0", 10);
  return Number.isNaN(v) ? 0 : v;
};

export const useStudioStore = create<StudioState>((set) => ({
  job: null,
  bubbles: [],
  textSegBlocks: [],
  activeStage: "original",
  selectedBubbleIndex: null,
  selectedTextSegIndex: null,
  isTextSegDrawMode: false,
  showBubbles: false,
  showTextSeg: true,
  bubblePadding: storedPadding(),
  imageVersion: 0,
  leftCollapsed: false,
  rightCollapsed: false,
  isRedetecting: false,
  isReocring: false,
  isTranslating: false,
  isInpainting: false,
  isBurning: false,
  actionError: null,

  setJob: (job) => set({ job }),
  setBubbles: (bubbles) => set({ bubbles }),
  setTextSegBlocks: (textSegBlocks) => set({ textSegBlocks }),
  setActiveStage: (activeStage) => set({ activeStage, selectedBubbleIndex: null, selectedTextSegIndex: null }),
  selectBubble: (selectedBubbleIndex) => set({ selectedBubbleIndex, selectedTextSegIndex: null }),
  selectTextSeg: (selectedTextSegIndex) => set({ selectedTextSegIndex, selectedBubbleIndex: null }),
  setTextSegDrawMode: (isTextSegDrawMode) => set({ isTextSegDrawMode }),
  setShowBubbles: (showBubbles) => set({ showBubbles }),
  setShowTextSeg: (showTextSeg) => set({ showTextSeg }),
  setBubblePadding: (bubblePadding) => {
    localStorage.setItem("studio-bubble-padding", String(bubblePadding));
    set({ bubblePadding });
  },
  bumpImageVersion: () => set((s) => ({ imageVersion: s.imageVersion + 1 })),
  setLeftCollapsed: (leftCollapsed) => set({ leftCollapsed }),
  setRightCollapsed: (rightCollapsed) => set({ rightCollapsed }),
  setLoading: (flag, v) => set({ [flag]: v } as Partial<StudioState>),
  setActionError: (actionError) => set({ actionError }),
  reset: () =>
    set({
      job: null, bubbles: [], textSegBlocks: [],
      activeStage: "original",
      selectedBubbleIndex: null, selectedTextSegIndex: null,
      isTextSegDrawMode: false, actionError: null,
      isRedetecting: false, isReocring: false, isTranslating: false,
      isInpainting: false, isBurning: false,
    }),
}));
