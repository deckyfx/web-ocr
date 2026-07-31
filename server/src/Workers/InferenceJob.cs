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

public record InpaintJob(
    byte[]                       ImagePng,
    IReadOnlyList<BubbleBox>     Bubbles,
    int                          MaskDilate,
    TaskCompletionSource<object> Tcs
) : InferenceJob(Tcs);
