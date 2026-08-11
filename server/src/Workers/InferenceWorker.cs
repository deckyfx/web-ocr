using System.Diagnostics;

namespace WebOcrServer;

/// <summary>
/// Reads InferenceJob items from the channel and executes them serially.
/// Keeps ONNX sessions away from the ASP.NET thread pool.
/// </summary>
public sealed class InferenceWorker(
    InferenceQueue           queue,
    OcrEngine                ocr,
    TranslateService         translate,
    InpaintService           inpaintSvc,
    TextSegmentationService  textSegSvc,
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
                    OcrJob              j => await RunOcrAsync(j, ct),
                    TranslateJob        j => await RunTranslateAsync(j, ct),
                    InpaintJob          j => await RunInpaintAsync(j, ct),
                    TextSegJob          j => await RunTextSegAsync(j, ct),
                    InpaintWithMaskJob  j => await RunInpaintWithMaskAsync(j, ct),
                    _                     => throw new NotSupportedException($"Unknown job type: {job.GetType().Name}"),
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

    private async Task<byte[]> RunInpaintAsync(InpaintJob job, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var result = await Task.Run(() => inpaintSvc.InpaintPage(job.ImagePng, job.Bubbles, job.MaskDilate), ct);
        sw.Stop();
        logger.LogDebug("[Inpaint] Page inpainted in {Ms} ms", sw.ElapsedMilliseconds);
        return result;
    }

    private async Task<TextSegResult> RunTextSegAsync(TextSegJob job, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var result = await Task.Run(() => textSegSvc.SegmentText(job.ImagePng), ct);
        sw.Stop();
        logger.LogDebug("[TextSeg] Segmented text in {Ms} ms; {Count} text block(s)",
            sw.ElapsedMilliseconds, result.TextBlocks.Count);
        return result;
    }

    private async Task<byte[]> RunInpaintWithMaskAsync(InpaintWithMaskJob job, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var result = await Task.Run(
            () => inpaintSvc.InpaintPageWithPixelMask(job.ImagePng, job.TextMaskPng, job.Bubbles, job.MaskDilate), ct);
        sw.Stop();
        logger.LogDebug("[Inpaint] Pixel-mask inpaint in {Ms} ms", sw.ElapsedMilliseconds);
        return result;
    }
}
