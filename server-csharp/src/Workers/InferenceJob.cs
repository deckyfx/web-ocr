namespace WebOcrServer;

public abstract record InferenceJob(TaskCompletionSource<object> Tcs);

public record OcrJob(
    byte[] ImageBytes,
    string Engine,
    TaskCompletionSource<object> Tcs
) : InferenceJob(Tcs);

public record TranslateJob(
    string Text,
    string Engine,
    TaskCompletionSource<object> Tcs
) : InferenceJob(Tcs);

// Future: InpaintJob(byte[] Mask, byte[] Source, TaskCompletionSource<object> Tcs) : InferenceJob(Tcs)
