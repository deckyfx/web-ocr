using Microsoft.EntityFrameworkCore;

namespace WebOcrServer.Data;

public class Volume
{
    public int      Id             { get; set; }
    public string   Title          { get; set; } = "";
    public string?  Synopsis       { get; set; }
    public string?  CoverImagePath { get; set; }
    public int      SortOrder      { get; set; }
    public DateTime CreatedAt      { get; set; } = DateTime.UtcNow;

    public ICollection<Chapter>           Chapters { get; set; } = [];
}

public class Chapter
{
    public int      Id            { get; set; }
    public int?     VolumeId      { get; set; }
    public Volume?  Volume        { get; set; }
    public string   Title         { get; set; } = "";
    public string   ChapterNumber { get; set; } = "";
    public int      SortOrder     { get; set; }
    public DateTime CreatedAt     { get; set; } = DateTime.UtcNow;

    public ICollection<PageTranslationJob> Jobs { get; set; } = [];
}

/// <summary>Persistent record of a completed (or in-progress) translate-page pipeline run.</summary>
public class PageTranslationJob
{
    public string    Id                { get; set; } = "";
    public string    Title             { get; set; } = "";
    public string    Status            { get; set; } = "processing";   // processing | done | error
    public string    OriginalImagePath { get; set; } = "";
    public string?   ResultImagePath   { get; set; }
    public int       OriginalWidth     { get; set; }
    public int       OriginalHeight    { get; set; }
    public int       BubbleCount       { get; set; }
    public int?      ChapterId         { get; set; }
    public Chapter?  Chapter           { get; set; }
    public int       PageOrder         { get; set; }
    public string?   ErrorMessage      { get; set; }
    public DateTime  CreatedAt         { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedAt       { get; set; }
}

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

/// <summary>Per-bubble OCR + translation result, editable via the portal studio.</summary>
public class PageTranslationLog
{
    public int                  Id              { get; set; }
    public string               JobId           { get; set; } = "";
    public PageTranslationJob?  Job             { get; set; }
    public int                  BubbleIndex     { get; set; }
    public float     BubbleX         { get; set; }
    public float     BubbleY         { get; set; }
    public float     BubbleW         { get; set; }
    public float     BubbleH         { get; set; }
    public float     Confidence      { get; set; }
    public string    SourceText      { get; set; } = "";
    public string    TranslatedText  { get; set; } = "";
    public bool      IsManuallyAdded { get; set; }
    public bool      IsExcluded      { get; set; }
    public DateTime? LastEditedAt    { get; set; }
    public DateTime  CreatedAt       { get; set; } = DateTime.UtcNow;
}

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<OcrLog>              OcrLogs              { get; set; }
    public DbSet<TranslateLog>        TranslateLogs        { get; set; }
    public DbSet<PageTranslationLog>  PageTranslationLogs  { get; set; }
    public DbSet<Volume>              Volumes              { get; set; }
    public DbSet<Chapter>             Chapters             { get; set; }
    public DbSet<PageTranslationJob>  PageTranslationJobs  { get; set; }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        modelBuilder.Entity<PageTranslationLog>()
            .HasOne(l => l.Job)
            .WithMany()
            .HasForeignKey(l => l.JobId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
