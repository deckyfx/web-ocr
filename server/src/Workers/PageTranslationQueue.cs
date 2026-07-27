using System.Threading.Channels;

namespace WebOcrServer;

/// <summary>
/// Bounded channel that queues page-translation jobs for <see cref="PageTranslationWorker"/>.
/// Unlike the CPU-bound <see cref="InferenceQueue"/>, each item here is a full orchestration job
/// (OCR → translate → typeset) that itself drives the InferenceQueue internally.
/// </summary>
public sealed class PageTranslationQueue
{
    private readonly Channel<PageTranslationItem> _channel =
        Channel.CreateBounded<PageTranslationItem>(new BoundedChannelOptions(32)
        {
            SingleReader = true,
            FullMode = BoundedChannelFullMode.Wait,
        });

    public ChannelWriter<PageTranslationItem> Writer => _channel.Writer;
    public ChannelReader<PageTranslationItem> Reader => _channel.Reader;
}

public sealed record PageTranslationItem(string JobId, byte[] PngBytes);
