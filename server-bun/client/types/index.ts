export interface Volume {
  id: number;
  title: string;
  coverPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Chapter {
  id: number;
  volumeId: number;
  title: string;
  sortOrder: number;
  pagesDir: string;
  createdAt: string;
  updatedAt: string;
}

export interface PageTranslationJob {
  id: string;
  imageHash: string;
  sourcePath: string;
  status: string;
  totalBubbles: number;
  processedBubbles: number;
  errorMessage: string | null;
  textSegBlocks: string | null;
  inpaintEnabled: boolean;
  bubbleEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TranslationBubble {
  id: number;
  jobId: string;
  bubbleIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  sourceText: string | null;
  translatedText: string | null;
  ocrLogId: number | null;
  translateLogId: number | null;
  inpaintedImagePath: string | null;
  patchImagePath: string | null;
  createdAt: string;
  updatedAt: string;
  styleJson: string | null;
}

export interface TextSegBlock {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  source_text: string | null;
  translated_text: string | null;
}

export interface BubbleStyle {
  fontFamily?: string;
  fontSize?: number;
  fontColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  textAlign?: "left" | "center" | "right";
}

export interface HealthStatus {
  status: "starting" | "ready" | "degraded";
  ocr: boolean;
  translate: boolean;
  dictionary: boolean;
  inpaint: boolean | "disabled";
  bubble: boolean | "disabled";
  text_seg: boolean | "disabled";
}

export interface ServerSettings {
  ocr: ModelInfo;
  translate: ModelInfo;
  inpaint: ModelInfo;
  bubble: ModelInfo;
  text_seg: ModelInfo;
  preferred_translation_engine: string;
  inpaint_engine: string;
  deepl_configured: boolean;
}

export interface ModelInfo {
  repo: string;
  dir: string;
  enabled: boolean;
  files: string[];
  ready: boolean;
}
