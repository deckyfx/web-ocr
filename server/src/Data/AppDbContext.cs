using Microsoft.EntityFrameworkCore;

namespace WebOcrServer.Data;

public class OcrLog
{
    public int      Id          { get; set; }
    public string   Text        { get; set; } = "";
    public string?  Translation { get; set; }
    public string?  TargetLang  { get; set; }
    public long?    ElapsedMs   { get; set; }
    public DateTime CreatedAt   { get; set; } = DateTime.UtcNow;
}

public class TranslateLog
{
    public int      Id         { get; set; }
    public string   SourceText { get; set; } = "";
    public string   Translated { get; set; } = "";
    public string   TargetLang { get; set; } = "en";
    public long?    ElapsedMs  { get; set; }
    public DateTime CreatedAt  { get; set; } = DateTime.UtcNow;
}

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<OcrLog>       OcrLogs       { get; set; }
    public DbSet<TranslateLog> TranslateLogs { get; set; }
}
