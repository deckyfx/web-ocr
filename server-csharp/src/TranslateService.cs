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
    private const int   DecoderStartToken  = 60715; // PAD / decoder_start_token_id
    private const int   EosToken           = 0;
    private const int   MaxLength          = 150;   // 512 caused runaway loops; 150 is still generous for any manga line
    private const float RepetitionPenalty  = 1.3f;  // >1.0 discourages repeating already-generated tokens
    private const int   NoRepeatNgramSize  = 3;     // ban any token that would form a repeated 3-gram

    public bool IsReady => _encoder is not null && _decoder is not null && _srcTokenizer is not null;

    /// <summary>Called by BootExtensions after models are downloaded.</summary>
    public async Task InitializeAsync(
        string encoderPath,
        string decoderPath,
        string tokenizerJsonPath,
        CancellationToken ct = default)
    {
        var opts = MakeSessionOptions();
        _encoder = await Task.Run(() => new InferenceSession(encoderPath, opts), ct);
        _decoder = await Task.Run(() => new InferenceSession(decoderPath, opts), ct);

        // UnigramTokenizer reads HuggingFace tokenizer.json (model.type == "Unigram")
        _srcTokenizer = await Task.Run(() => UnigramTokenizer.FromJson(tokenizerJsonPath), ct);
        _tgtTokenizer = _srcTokenizer;

        Console.WriteLine("[Translate] Opus-MT sessions loaded.");
        await Task.Run(() => WarmUp(), ct);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /// <summary>
    /// Translates text using the requested engine ("auto", "local", "deepl", or "none").
    /// "auto" uses DeepL when DEEPL_API_KEY is configured, otherwise falls back to local.
    /// Returns null when engine is "none" or on failure.
    /// </summary>
    public async Task<string?> TranslateAsync(
        string text, string engine, CancellationToken ct = default)
    {
        if (engine == "none" || string.IsNullOrWhiteSpace(text)) return null;

        // "auto" = DeepL if key is available, otherwise local
        if (engine == "auto")
            engine = config.DeeplAvailable ? "deepl" : "local";

        if (engine == "deepl")
        {
            if (!config.DeeplAvailable)
            {
                logger.LogWarning("DeepL requested but DEEPL_API_KEY is not configured; returning null.");
                return null;
            }
            return await DeeplTranslateAsync(text, ct);
        }

        if (IsReady)
            return await Task.Run(() => LocalTranslate(text), ct);

        logger.LogWarning("Local translate requested but models not ready; returning null.");
        return null;
    }

    // ── Session setup ─────────────────────────────────────────────────────────

    private static Microsoft.ML.OnnxRuntime.SessionOptions MakeSessionOptions()
    {
        var opts = new Microsoft.ML.OnnxRuntime.SessionOptions();
        opts.GraphOptimizationLevel = GraphOptimizationLevel.ORT_ENABLE_ALL;
        opts.ExecutionMode          = ExecutionMode.ORT_PARALLEL;
        opts.InterOpNumThreads      = Environment.ProcessorCount;
        opts.IntraOpNumThreads      = Environment.ProcessorCount;
        return opts;
    }

    private void WarmUp()
    {
        // Encode a short dummy token sequence to compile encoder ops
        var ids  = new DenseTensor<long>(new[] { 1, 1 });
        var mask = new DenseTensor<long>(new[] { 1, 1 });
        ids[0, 0] = mask[0, 0] = 1L;
        var encoderInputs = new List<NamedOnnxValue>
        {
            NamedOnnxValue.CreateFromTensor("input_ids",      ids),
            NamedOnnxValue.CreateFromTensor("attention_mask", mask),
        };
        using var encoderOut = _encoder!.Run(encoderInputs);
        var hidden = encoderOut[0].Value as DenseTensor<float> ?? throw new InvalidOperationException();

        // One decoder step to compile decoder ops
        var decIds = new DenseTensor<long>(new[] { 1, 1 });
        decIds[0, 0] = DecoderStartToken;
        var decoderInputs = new List<NamedOnnxValue>
        {
            NamedOnnxValue.CreateFromTensor("input_ids",              decIds),
            NamedOnnxValue.CreateFromTensor("encoder_hidden_states",  hidden),
            NamedOnnxValue.CreateFromTensor("encoder_attention_mask", mask),
        };
        using var _ = _decoder!.Run(decoderInputs);
        Console.WriteLine("[Translate] Warm-up complete.");
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

            // Tokens that would complete a repeated n-gram are hard-banned
            var banned    = GetBannedNgramTokens(tokens, NoRepeatNgramSize);
            // Tokens already generated are penalised (soft discouragement)
            var seenSet   = new HashSet<int>(tokens);

            int   nextToken = EosToken;
            float maxLogit  = float.MinValue;

            for (int v = 0; v < vocabSize; v++)
            {
                if (banned.Contains(v)) continue;

                float logit = logits.GetValue(lastRowOffset + v);

                // Repetition penalty: divide positive logits, multiply negative logits
                if (seenSet.Contains(v))
                    logit = logit > 0f ? logit / RepetitionPenalty : logit * RepetitionPenalty;

                if (logit > maxLogit) { maxLogit = logit; nextToken = v; }
            }

            // EOS or PAD both signal end-of-sequence
            if (nextToken == EosToken || nextToken == DecoderStartToken) break;
            tokens.Add(nextToken);
        }

        return tokens;
    }

    /// <summary>
    /// Returns the set of token IDs whose selection would create a repeated n-gram.
    /// Scans history for every occurrence of the last (ngramSize-1) tokens and
    /// collects the token that followed each occurrence.
    /// </summary>
    private static HashSet<int> GetBannedNgramTokens(List<int> tokens, int ngramSize)
    {
        var banned    = new HashSet<int>();
        int len       = tokens.Count;
        int prefixLen = ngramSize - 1;

        if (len < prefixLen) return banned;

        int prefixStart = len - prefixLen;

        for (int i = 0; i <= len - ngramSize; i++)
        {
            bool match = true;
            for (int j = 0; j < prefixLen; j++)
            {
                if (tokens[i + j] != tokens[prefixStart + j]) { match = false; break; }
            }
            if (match) banned.Add(tokens[i + prefixLen]);
        }

        return banned;
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
        catch (OperationCanceledException)
        {
            throw;
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
