namespace WebOcrServer;

public record OcrRequest(
    string Image,
    string? TranslateEngine = "none",
    bool?   TrackJob        = null
);

public record TranslateRequest(
    string Text,
    string? TranslateEngine = "local"
);

public record AnalyzeRequest(
    string Text,
    bool Sanitize = true,
    string Mode = "local"
);
