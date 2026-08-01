namespace WebOcrServer;

public record OcrResponse(
    string Text,
    string? Translation,
    long    ElapsedMs,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? JobId = null
);

public record TranslateResponse(
    string Translation,
    long ElapsedMs
);

public record AnalyzeResponse(
    string Original,
    string Sanitized,
    List<string> Sentences,
    List<TokenInfo> Tokens,
    Definition?[] Definitions,
    long ElapsedMs
);

public record TokenInfo(
    string Surface,
    string Pos,
    string PosDetail,
    string ConjugationType,
    string ConjugationForm,
    string DictionaryForm,
    string Reading,
    string Romaji,
    bool IsUnknown
);

public record Definition(
    string Word,
    string Reading,
    bool IsCommon,
    string? Jlpt,
    List<string> Glosses
);

public record ModelStatus(string Name, bool Ready, bool Enabled = true);

public record HealthResponse(
    string Status,
    string Version,
    string DataDir,
    bool DeeplAvailable,
    string PreferredTranslationEngine,
    string PreferredInpaintEngine,
    Dictionary<string, ModelStatus> Models
);
