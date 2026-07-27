namespace WebOcrServer;

public enum JobStatus { Pending, Running, Done, Error }

/// <summary>A single structured log entry emitted during page translation, streamed via SSE.</summary>
/// <param name="Type">"log" for progress, "done" for completion, "error" for failure.</param>
/// <param name="Message">Human-readable description of the stage.</param>
/// <param name="Stage">Pipeline stage name (detecting / ocr / translating / inpainting / typesetting / done).</param>
/// <param name="Progress">Fraction complete 0–1.</param>
/// <param name="Count">Optional count (e.g. number of bubbles detected).</param>
/// <param name="Result">Base64 PNG result — only present on the terminal "done" entry.</param>
/// <param name="Error">Error message — only present on "error" entries.</param>
public record JobLogEntry(
    string  Type,
    string  Message,
    string? Stage    = null,
    double  Progress = 0,
    int?    Count    = null,
    string? Result   = null,
    string? Error    = null);

public sealed class TranslationJob
{
    public string    Id          { get; } = Guid.NewGuid().ToString("N")[..12];
    public JobStatus Status      { get; set; } = JobStatus.Pending;
    public string    Stage       { get; set; } = "";
    public double    Progress    { get; set; }
    public string?   Result      { get; set; } // base64 PNG
    public string?   Error       { get; set; }
    public DateTime  CreatedAt   { get; }      = DateTime.UtcNow;
    public DateTime? CompletedAt { get; set; }

    /// <summary>Append-only log used by the SSE stream endpoint.</summary>
    public List<JobLogEntry> Logs { get; } = new();
}

/// <summary>
/// Thread-safe in-memory store for <see cref="TranslationJob"/> objects.
/// Completed jobs are evicted 5 minutes after completion to bound memory use.
/// </summary>
public sealed class TranslationJobStore
{
    private readonly Dictionary<string, TranslationJob> _jobs = new();
    private readonly object _lock = new();

    /// <summary>Create a new job, add it to the store, and evict stale completed jobs.</summary>
    public TranslationJob Create()
    {
        var job = new TranslationJob();
        lock (_lock)
        {
            _jobs[job.Id] = job;
            Evict();
        }
        return job;
    }

    /// <summary>Returns the job for the given id, or null if not found / already evicted.</summary>
    public TranslationJob? Get(string id)
    {
        lock (_lock) return _jobs.TryGetValue(id, out var j) ? j : null;
    }

    /// <summary>Apply a mutation to a job under the store lock.</summary>
    public void Update(TranslationJob job, Action<TranslationJob> mutate)
    {
        lock (_lock) mutate(job);
    }

    /// <summary>Append a log entry to the job's <see cref="TranslationJob.Logs"/> list under the store lock.</summary>
    public void AddLog(TranslationJob job, JobLogEntry entry)
    {
        lock (_lock) job.Logs.Add(entry);
    }

    /// <summary>
    /// Returns a snapshot of all log entries starting at <paramref name="offset"/>.
    /// Thread-safe — taken under the store lock.
    /// </summary>
    public List<JobLogEntry> GetLogsFrom(TranslationJob job, int offset)
    {
        lock (_lock) return job.Logs.Skip(offset).ToList();
    }

    // ── private helpers ───────────────────────────────────────────────────────

    /// <summary>Remove jobs completed more than 5 minutes ago. Must be called inside _lock.</summary>
    private void Evict()
    {
        var cutoff = DateTime.UtcNow.AddMinutes(-5);
        var stale  = _jobs.Values
            .Where(j => j.CompletedAt.HasValue && j.CompletedAt < cutoff)
            .Select(j => j.Id)
            .ToList();
        foreach (var id in stale) _jobs.Remove(id);
    }
}
