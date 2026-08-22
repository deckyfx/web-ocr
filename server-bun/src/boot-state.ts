/** Mirrors C# BootState — tracks readiness of each service component. */
export class BootState {
  private static instance: BootState;

  isReady = false;
  ocrReady = false;
  translateReady = false;
  dictionaryReady = false;
  inpaintReady = false;
  bubbleReady = false;
  textSegReady = false;

  inpaintEnabled = false;
  bubbleEnabled = false;
  textSegEnabled = false;

  get healthStatus(): "starting" | "ready" | "degraded" {
    if (!this.isReady) return "starting";
    if (!this.dictionaryReady) return "degraded";
    return "ready";
  }

  static getInstance(): BootState {
    if (!BootState.instance) BootState.instance = new BootState();
    return BootState.instance;
  }
}

export const bootState = BootState.getInstance();
