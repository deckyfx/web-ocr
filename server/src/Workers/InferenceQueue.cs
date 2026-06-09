using System.Threading.Channels;

namespace WebOcrServer;

/// <summary>
/// Singleton bounded channel that serialises ONNX inference work.
/// SingleReader=true keeps one active inference at a time — safe on CPU-only setups.
/// To scale up: set SingleReader=false and register InferenceWorker multiple times.
/// </summary>
public sealed class InferenceQueue
{
    private readonly Channel<InferenceJob> _channel =
        Channel.CreateBounded<InferenceJob>(new BoundedChannelOptions(64)
        {
            FullMode     = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = false,
        });

    public ChannelWriter<InferenceJob> Writer => _channel.Writer;
    public ChannelReader<InferenceJob> Reader => _channel.Reader;
}
