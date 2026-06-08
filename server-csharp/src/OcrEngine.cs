using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;
using SkiaSharp;

namespace WebOcrServer;

public class OcrEngine
{
    public InferenceSession? Encoder { get; private set; }
    public InferenceSession? Decoder { get; private set; }
    public List<string>? Vocabulary { get; private set; }

    private const long BOS_TOKEN = 2;
    private const long EOS_TOKEN = 3;
    private const int MAX_LENGTH = 300;
    private const int SPECIAL_TOKEN_CUTOFF = 14;

    public async Task InitializeAsync(string encoderPath, string decoderPath, string vocabPath)
    {
        Encoder = await Task.Run(() => new InferenceSession(encoderPath));
        Decoder = await Task.Run(() => new InferenceSession(decoderPath));
        Vocabulary = await Task.Run(() => new List<string>(File.ReadAllLines(vocabPath)));
    }

    public string ProcessOcr(byte[] imageBytes)
    {
        using var stream = new MemoryStream(imageBytes);
        using var originalBitmap = SKBitmap.Decode(stream);

        if (originalBitmap == null)
        {
            throw new ArgumentException("Failed to decode image bytes.");
        }

        bool isVertical = originalBitmap.Height > originalBitmap.Width;
        Console.WriteLine($"[OCR Engine] Dimensions: {originalBitmap.Width}x{originalBitmap.Height} | Layout: {(isVertical ? "Vertical" : "Horizontal")}");

        // 1. Convert to Grayscale
        var grayBitmap = new SKBitmap(originalBitmap.Width, originalBitmap.Height, SKColorType.Gray8, SKAlphaType.Opaque);
        using (var canvas = new SKCanvas(grayBitmap))
        {
            using var paint = new SKPaint();
            paint.ColorFilter = SKColorFilter.CreateColorMatrix(new float[]
            {
                0.2126f, 0.7152f, 0.0722f, 0f, 0f,
                0.2126f, 0.7152f, 0.0722f, 0f, 0f,
                0.2126f, 0.7152f, 0.0722f, 0f, 0f,
                0f,      0f,      0f,      1f, 0f
            });
            canvas.DrawBitmap(originalBitmap, 0, 0, paint);
        }

        // 2. Background Inversion logic matching Rust
        long totalBrightness = 0;
        int pixelCount = grayBitmap.Width * grayBitmap.Height;
        
        unsafe
        {
            byte* ptr = (byte*)grayBitmap.GetPixels().ToPointer();
            for (int i = 0; i < pixelCount; i++)
            {
                totalBrightness += ptr[i];
            }

            double meanBrightness = (double)totalBrightness / pixelCount;
            if (meanBrightness < 127.0)
            {
                for (int i = 0; i < pixelCount; i++)
                {
                    ptr[i] = (byte)(255 - ptr[i]);
                }
            }
        }

        // 3. Proportional Scaling to fit inside 224x224
        double scale = 224.0 / Math.Max(grayBitmap.Width, grayBitmap.Height);
        int scaledW = Math.Max((int)(grayBitmap.Width * scale), 1);
        int scaledH = Math.Max((int)(grayBitmap.Height * scale), 1);

        using var resizedBitmap = new SKBitmap(scaledW, scaledH, SKColorType.Gray8, SKAlphaType.Opaque);
        grayBitmap.ScalePixels(resizedBitmap, new SKSamplingOptions(SKCubicResampler.Mitchell));

        // 4. Center on a solid white 224x224 canvas
        using var canvasTarget = new SKBitmap(224, 224, SKColorType.Gray8, SKAlphaType.Opaque);
        using (var canvas = new SKCanvas(canvasTarget))
        {
            canvas.Clear(SKColors.White);
            int xOff = (224 - scaledW) / 2;
            int yOff = (224 - scaledH) / 2;
            canvas.DrawBitmap(resizedBitmap, xOff, yOff);
        }

        // 5. Build Flat CHW Tensor Normalized to [-1, 1]
        var inputTensor = new DenseTensor<float>(new[] { 1, 3, 224, 224 });
        
        unsafe
        {
            byte* canvasPtr = (byte*)canvasTarget.GetPixels().ToPointer();
            for (int i = 0; i < 224 * 224; i++)
            {
                int y = i / 224;
                int x = i % 224;
                
                float normalizedValue = ((canvasPtr[i] / 255.0f) - 0.5f) / 0.5f;
                
                inputTensor[0, 0, y, x] = normalizedValue;
                inputTensor[0, 1, y, x] = normalizedValue;
                inputTensor[0, 2, y, x] = normalizedValue;
            }
        }

        // 6. Encoder Inference Pass
        var encoderInputs = new List<NamedOnnxValue>
        {
            NamedOnnxValue.CreateFromTensor("pixel_values", inputTensor)
        };

        using var encoderResults = Encoder!.Run(encoderInputs);
        var lastHiddenState = encoderResults[0].Value as DenseTensor<float>;

        // 7. Decode Tokens
        return RunDecoderLoop(lastHiddenState!);
    }

    private string RunDecoderLoop(DenseTensor<float> encoderHiddenStates)
    {
        var tokens = new List<long> { BOS_TOKEN };

        while (tokens.Count < MAX_LENGTH)
        {
            var inputIdsTensor = new DenseTensor<long>(new[] { 1, tokens.Count });
            for (int i = 0; i < tokens.Count; i++)
            {
                inputIdsTensor[0, i] = tokens[i];
            }

            var decoderInputs = new List<NamedOnnxValue>
            {
                NamedOnnxValue.CreateFromTensor("input_ids", inputIdsTensor),
                NamedOnnxValue.CreateFromTensor("encoder_hidden_states", encoderHiddenStates)
            };

            using var decoderResults = Decoder!.Run(decoderInputs);
            var logits = decoderResults[0].Value as DenseTensor<float>;
            
            int vocabSize = (int)logits!.Dimensions[2];
            int lastRowOffset = (logits.Dimensions[1] - 1) * vocabSize;

            long nextToken = EOS_TOKEN;
            float maxLogitValue = float.MinValue;

            for (int v = 0; v < vocabSize; v++)
            {
                float logit = logits.GetValue(lastRowOffset + v);
                if (logit > maxLogitValue)
                {
                    maxLogitValue = logit;
                    nextToken = v;
                }
            }

            if (nextToken == EOS_TOKEN)
            {
                break;
            }

            tokens.Add(nextToken);
        }

        return Detokenize(tokens);
    }

    private string Detokenize(List<long> tokens)
    {
        var outWords = new List<string>();

        foreach (var id in tokens)
        {
            if (id <= SPECIAL_TOKEN_CUTOFF) continue;

            if (id < Vocabulary!.Count)
            {
                string tokenStr = Vocabulary[(int)id];
                
                if (tokenStr.StartsWith(" ")) tokenStr = tokenStr.Replace(" ", "");
                if (tokenStr.StartsWith("##")) tokenStr = tokenStr.Substring(2);

                outWords.Add(tokenStr);
            }
        }

        return string.Join("", outWords).Trim();
    }
}