using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;

namespace WebOcrServer;

/// <summary>
/// Opus-MT (Xenova/opus-mt-ja-en) local translation + DeepL HTTP fallback.
/// Port of server/src/services/translate.rs.
/// </summary>
public sealed class TranslateService(AppConfig config, HttpClient http, ILogger<TranslateService> logger) : IDisposable
{
    private InferenceSession?  _encoder;
    private InferenceSession?  _decoder;
    private UnigramTokenizer?  _srcTokenizer;  // Unigram SentencePiece (tokenizer.json)
    private UnigramTokenizer?  _tgtTokenizer;  // same model encodes both sides

    // MarianMT special token IDs for Xenova/opus-mt-ja-en
    private const int DecoderStartToken = 60715; // PAD / decoder_start_token_id
    private const int EosToken          = 0;
    private const int MaxLength         = 512;

    public bool IsReady => _encoder is not null && _decoder is not null && _srcTokenizer is not null;

    /// <summary>Called by BootExtensions after models are downloaded.</summary>
    public async Task InitializeAsync(
        string encoderPath,
        string decoderPath,
        string tokenizerJsonPath,
        CancellationToken ct = default)
    {
        _encoder = await Task.Run(() => new InferenceSession(encoderPath), ct);
        _decoder = await Task.Run(() => new InferenceSession(decoderPath), ct);

        // UnigramTokenizer reads HuggingFace tokenizer.json (model.type == "Unigram")
        _srcTokenizer = await Task.Run(() => UnigramTokenizer.FromJson(tokenizerJsonPath), ct);
        _tgtTokenizer = _srcTokenizer;

        Console.WriteLine("[Translate] Opus-MT sessions loaded.");
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /// <summary>
    /// Translates text using the requested engine ("local", "deepl", or "none").
    /// Returns null when engine is "none" or on failure.
    /// </summary>
    public async Task<string?> TranslateAsync(
        string text, string engine, CancellationToken ct = default)
    {
        if (engine == "none" || string.IsNullOrWhiteSpace(text)) return null;

        if (engine == "deepl" && config.DeeplAvailable)
            return await DeeplTranslateAsync(text, ct);

        if (IsReady)
            return await Task.Run(() => LocalTranslate(text), ct);

        logger.LogWarning("Local translate requested but models not ready; returning null.");
        return null;
    }

    // ── Local ONNX translation ────────────────────────────────────────────────

    private string LocalTranslate(string text)
    {
        // Encode source text
        var inputIds = _srcTokenizer!.EncodeToIds(text);
        int seqLen   = inputIds.Count;

        // Build encoder tensors
        var inputIdsTensor = new DenseTensor<long>(new[] { 1, seqLen });
        var attnMaskTensor = new DenseTensor<long>(new[] { 1, seqLen });
        for (int i = 0; i < seqLen; i++)
        {
            inputIdsTensor[0, i] = inputIds[i];
            attnMaskTensor[0, i] = 1L;
        }

        // Run encoder
        var encoderInputs = new List<NamedOnnxValue>
        {
            NamedOnnxValue.CreateFromTensor("input_ids",      inputIdsTensor),
            NamedOnnxValue.CreateFromTensor("attention_mask", attnMaskTensor),
        };
        using var encoderOut   = _encoder!.Run(encoderInputs);
        var hiddenState = encoderOut[0].Value as DenseTensor<float>
                          ?? throw new InvalidOperationException("Encoder output is not a float tensor");

        // Greedy decode
        var generated = RunDecoderLoop(hiddenState, attnMaskTensor);

        // Decode token ids back to text (skip the leading start token)
        return _tgtTokenizer!.Decode(generated.Skip(1)) ?? "";
    }

    private List<int> RunDecoderLoop(DenseTensor<float> encoderHidden, DenseTensor<long> encoderMask)
    {
        var tokens = new List<int> { DecoderStartToken };

        while (tokens.Count < MaxLength)
        {
            int curLen = tokens.Count;
            var inputIdsTensor = new DenseTensor<long>(new[] { 1, curLen });
            for (int i = 0; i < curLen; i++) inputIdsTensor[0, i] = tokens[i];

            var decoderInputs = new List<NamedOnnxValue>
            {
                NamedOnnxValue.CreateFromTensor("input_ids",              inputIdsTensor),
                NamedOnnxValue.CreateFromTensor("encoder_hidden_states",  encoderHidden),
                NamedOnnxValue.CreateFromTensor("encoder_attention_mask", encoderMask),
            };

            using var decoderOut = _decoder!.Run(decoderInputs);
            var logits = decoderOut[0].Value as DenseTensor<float>
                         ?? throw new InvalidOperationException("Decoder output is not a float tensor");

            int vocabSize     = (int)logits.Dimensions[2];
            int lastRowOffset = (curLen - 1) * vocabSize;

            int    nextToken   = EosToken;
            float  maxLogit    = float.MinValue;
            for (int v = 0; v < vocabSize; v++)
            {
                float logit = logits.GetValue(lastRowOffset + v);
                if (logit > maxLogit) { maxLogit = logit; nextToken = v; }
            }

            if (nextToken == EosToken) break;
            tokens.Add(nextToken);
        }

        return tokens;
    }

    // ── DeepL fallback ────────────────────────────────────────────────────────

    private async Task<string?> DeeplTranslateAsync(string text, CancellationToken ct)
    {
        // Free keys end in ":fx" and use the free endpoint
        var host = config.DeeplApiKey.EndsWith(":fx", StringComparison.Ordinal)
            ? "api-free.deepl.com"
            : "api.deepl.com";

        try
        {
            using var req  = new HttpRequestMessage(HttpMethod.Post, $"https://{host}/v2/translate");
            req.Headers.Add("Authorization", $"DeepL-Auth-Key {config.DeeplApiKey}");
            req.Content = JsonContent.Create(new
            {
                text        = new[] { text },
                target_lang = "EN",
                source_lang = "JA",
            });

            using var resp = await http.SendAsync(req, ct);
            resp.EnsureSuccessStatusCode();

            using var doc  = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct));
            return doc.RootElement
                      .GetProperty("translations")[0]
                      .GetProperty("text")
                      .GetString();
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "DeepL translation failed");
            return null;
        }
    }

    public void Dispose()
    {
        _encoder?.Dispose();
        _decoder?.Dispose();
    }
}
