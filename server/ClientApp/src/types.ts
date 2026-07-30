export interface Volume {
  id: number;
  title: string;
  synopsis?: string;
  coverImagePath?: string;
  sortOrder: number;
  createdAt: string;
  chapterCount?: number;
}

export interface Chapter {
  id: number;
  volumeId?: number;
  title: string;
  chapterNumber: string;
  sortOrder: number;
  createdAt: string;
  pageCount?: number;
}

export interface PageTranslationJob {
  id: string;
  title: string;
  status: "processing" | "done" | "error";
  originalImagePath: string;
  inpaintedImagePath?: string;
  resultImagePath?: string;
  originalWidth: number;
  originalHeight: number;
  bubbleCount: number;
  chapterId?: number;
  pageOrder: number;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

export interface TranslationBubble {
  id: number;
  jobId: string;
  bubbleIndex: number;
  bubbleX: number;
  bubbleY: number;
  bubbleW: number;
  bubbleH: number;
  confidence: number;
  sourceText: string;
  translatedText: string;
  isManuallyAdded: boolean;
  isExcluded: boolean;
  fontFamily?: string;
  fontSizeOverride?: number;
  lastEditedAt?: string;
  createdAt: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
