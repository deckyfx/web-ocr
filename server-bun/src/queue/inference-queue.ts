/** Sequential inference queue — replaces C# Channel<InferenceJob> + InferenceWorker. */

export type InferenceJobType = "ocr" | "translate" | "text-seg" | "bubble" | "inpaint";

export interface InferenceJob<TInput = unknown, TOutput = unknown> {
  type: InferenceJobType;
  input: TInput;
  resolve: (result: TOutput) => void;
  reject: (err: Error) => void;
}

class InferenceQueue {
  private static instance: InferenceQueue;
  private queue: InferenceJob[] = [];
  private processing = false;

  static getInstance(): InferenceQueue {
    if (!InferenceQueue.instance) InferenceQueue.instance = new InferenceQueue();
    return InferenceQueue.instance;
  }

  enqueue<TInput, TOutput>(type: InferenceJobType, input: TInput): Promise<TOutput> {
    return new Promise<TOutput>((resolve, reject) => {
      this.queue.push({ type, input, resolve: resolve as (r: unknown) => void, reject });
      this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      try {
        const result = await this.dispatch(job);
        job.resolve(result);
      } catch (err) {
        job.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    this.processing = false;
  }

  private async dispatch(job: InferenceJob): Promise<unknown> {
    switch (job.type) {
      case "ocr":       return inferenceHandlers.ocr(job.input);
      case "translate": return inferenceHandlers.translate(job.input);
      case "text-seg":  return inferenceHandlers["text-seg"](job.input);
      case "bubble":    return inferenceHandlers.bubble(job.input);
      case "inpaint":   return inferenceHandlers.inpaint(job.input);
      default:
        throw new Error(`Unknown inference job type: ${job.type}`);
    }
  }
}

/** Handlers are registered by each service at boot time. */
export const inferenceHandlers: Record<InferenceJobType, (input: unknown) => Promise<unknown>> = {
  ocr: async () => { throw new Error("OCR service not loaded"); },
  translate: async () => { throw new Error("Translate service not loaded"); },
  "text-seg": async () => { throw new Error("TextSeg service not loaded"); },
  bubble: async () => { throw new Error("Bubble service not loaded"); },
  inpaint: async () => { throw new Error("Inpaint service not loaded"); },
};

export const inferenceQueue = InferenceQueue.getInstance();
