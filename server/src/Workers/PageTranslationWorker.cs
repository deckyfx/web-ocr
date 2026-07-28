namespace WebOcrServer;

/// <summary>
/// Hosted service that drains <see cref="PageTranslationQueue"/> and runs full page-translation
/// jobs (OCR → translate → typeset) one at a time, keeping them off the ASP.NET thread pool.
/// </summary>
public sealed class PageTranslationWorker(
    PageTranslationQueue    queue,
    PageTranslationService  translationSvc,
    ILogger<PageTranslationWorker> logger
) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        await foreach (var item in queue.Reader.ReadAllAsync(ct))
        {
            try
            {
                await translationSvc.TranslatePageAsync(
                    item.JobId, item.PngBytes,
                    new Progress<PageTranslationProgress>(),
                    log: null,
                    ct: ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                logger.LogWarning("Page translation job {JobId} cancelled at shutdown", item.JobId);
                break;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Page translation job {JobId} failed", item.JobId);
                await translationSvc.MarkJobFailedAsync(item.JobId, ex.Message);
            }
        }
    }
}
