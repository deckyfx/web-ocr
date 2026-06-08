using System.Diagnostics;

namespace WebOcrServer;

/// <summary>
/// Reads InferenceJob items from the channel and executes them serially.
/// Keeps ONNX sessions away from the ASP.NET thread pool.
/// </summary>
public sealed class InferenceWorker(
    InferenceQueue    queue,
    OcrEngine         ocr,
    TranslateService  translate,
    ILogger<InferenceWorker> logger
) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        await foreach (var job in queue.Reader.ReadAllAsync(ct))
        {
            try
            {
                object result = job switch
                {
                    OcrJob       j => await RunOcrAsync(j, ct),
                    TranslateJob j => await RunTranslateAsync(j, ct),
                    _              => throw new NotSupportedException($"Unknown job type: {job.GetType().Name}"),
                };
                job.Tcs.TrySetResult(result);
            }
            catch (OperationCanceledException)
            {
                job.Tcs.TrySetCanceled(ct);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Inference job failed");
                job.Tcs.TrySetException(ex);
            }
        }
    }

    private async Task<OcrResponse> RunOcrAsync(OcrJob job, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();

        var text = await Task.Run(() => ocr.ProcessOcr(job.ImageBytes), ct);

        string? translation = null;
        if (job.Engine is not "none" && !string.IsNullOrWhiteSpace(text))
            translation = await translate.TranslateAsync(text, job.Engine, ct);

        sw.Stop();
        return new OcrResponse(text, translation, sw.ElapsedMilliseconds);
    }

    private async Task<TranslateResponse> RunTranslateAsync(TranslateJob job, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var result = await translate.TranslateAsync(job.Text, job.Engine, ct);
        sw.Stop();
        return new TranslateResponse(result ?? "", sw.ElapsedMilliseconds);
    }
}
