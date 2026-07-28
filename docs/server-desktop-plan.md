# Server Desktop Shell — Design Plan

Bring the ASP.NET Core server (`server/`) to the desktop on **Windows, Linux, and macOS**, so the
same artifact can run either as a **headless console process** or as a **small Avalonia desktop app**
that supervises it (log terminal, start/stop, port + bind-mode config).

Also introduces a **single source of truth for semantic versioning** across the C# projects.

Status: **plan approved — not yet implemented.**

Decisions locked (2026-07-27):

| Decision | Choice |
|----------|--------|
| Architecture (§3) | **Option A** — one binary, dual mode, server hosted in-process |
| Version | **1.4.0** + `CHANGELOG.md` |
| Auto-start on GUI launch | **Yes**, persisted setting, default on |
| Tray icon / minimize-to-tray | **In scope**, Phase 3 |
| Model settings in the GUI | **In scope**, Phase 3 (wraps the existing `/api/settings`) |

---

## 1. Goals

| Goal | Detail |
|------|--------|
| Console mode | `webocr-server --console` (or no display available) behaves exactly like `dotnet run` does today |
| Desktop mode | GUI window: running log terminal, Start/Stop, port input, bind-mode selector, status indicator |
| Cross-platform | win-x64 (+arm64), linux-x64/arm64, osx-x64/arm64 publish targets |
| Bind mode | `0.0.0.0` (default) or `127.0.0.1`, configurable from GUI, env var, and CLI flag |
| Semantic version | One `VersionPrefix` in the repo, surfaced in the console banner, `/health`, and the GUI |
| No regression | Existing `dotnet run`, Docker/systemd, Blazor UI, and extension/desktop clients keep working unchanged |

### Non-goals (this phase)

- Installers (MSI/Inno/pkg/AppImage) — publish folders + a tarball/zip only
- Auto-update, service installation (`sc.exe`, systemd unit generation)
- Any change to the OCR/translate pipelines, the existing `desktop/` capture companion, or the extension

---

## 2. Current State (what the code does today)

| Concern | Today | Problem for desktop |
|---------|-------|---------------------|
| Entry point | `server/Program.cs` — top-level statements, `app.Run()` | Blocking; no start/stop; no arg parsing |
| Binding | `k.ListenAnyIP(port)` hard-coded, or `ListenUnixSocket(SOCKET_PATH)` | No localhost-only option |
| Port | `PORT` env / `.env`, default `3579` | Not changeable at runtime |
| Data dir | `Path.Combine(Directory.GetCurrentDirectory(), "data")` (`AppConfig.FromEnvironment`) | A GUI app's CWD is not the install dir — models/DB would land in unpredictable places |
| `.env` | Loaded from `Directory.GetCurrentDirectory()` | Same problem |
| Version | `<Version>1.3.0</Version>` in `server-csharp.csproj` only; `/health` returns the 4-part `1.3.0.0` | Not shared with other projects, no informational/SHA component |
| Logs | `ILogger` → console, plus ~29 raw `Console.Write*` calls (banner, download progress, config warnings) | Raw console writes bypass `ILogger`, so a GUI log view must capture **both** |
| Boot | `BootBackgroundService` + `BootState` (`starting`/`ok`/`degraded`) | Good — the GUI can poll/observe this directly for its status pill |
| Frontend build | `server-csharp.csproj` runs `bun run build` on every `Build` | Build machines need `bun`; publish pipeline must account for it |

---

## 3. Architecture — decision required

Two shapes were considered. **Option A is the approved design**; Option B is kept below as the
documented fallback if the Phase 1 spike shows Avalonia and the Web SDK can't cohabit.

### Option A — single project, dual mode ✅ approved

Add Avalonia to the existing `server/` project. `Program.cs` picks a mode from the args:

```
webocr-server                 → GUI (Avalonia shell, server stopped until Start / auto-start setting)
webocr-server --console       → headless, current behaviour, Ctrl-C to stop
webocr-server --console --port 8080 --bind localhost
```

The shell hosts the `WebApplication` **in-process**: Start builds a host and `StartAsync()`s it,
Stop calls `StopAsync()`/`DisposeAsync()`, a port/bind change rebuilds a fresh host.

| Pros | Cons |
|------|------|
| One binary — literally "console or desktop app" | Avalonia deps ride along in headless deployments (~+15 MB, never loaded unless GUI mode starts) |
| Log capture via a real `ILoggerProvider` — levels, categories, structured, no stdout parsing | Windows needs the `AttachConsole`/`FreeConsole` dance to have both a clean GUI and a working console mode |
| No cross-project static-web-asset (Blazor `_framework`) plumbing | Repeated in-process host restarts must fully dispose ONNX sessions (verify no leak) |
| Status comes straight from the `BootState` singleton — no HTTP polling | Avalonia XAML compiler inside a `Microsoft.NET.Sdk.Web` project is unusual (low risk, verify in Phase 1 spike) |

### Option B — separate shell project, child process

New `server-desktop/` Avalonia project spawns `server-csharp` as a child process and pipes
stdout/stderr into the log view.

| Pros | Cons |
|------|------|
| Zero refactor of the server; total crash isolation | Two binaries to ship and locate at runtime (path discovery, macOS `.app` layout) |
| Restart = kill + spawn, trivially correct | Logs are plain text — no levels/filtering without a structured log format |
| Server binary stays lean | Process lifetime edge cases (orphans on GUI crash, kill-tree on Windows) |

**Chosen: Option A.** It matches the request most directly, gives a much better log pane, and the
Windows console attach trick is well-trodden.

Everything below assumes Option A; only Phase 3 and the packaging section change materially under B.

---

## 4. Versioning

### 4.1 Single source of truth

New `Directory.Build.props` at the repo root:

```xml
<Project>
  <PropertyGroup>
    <VersionPrefix>1.4.0</VersionPrefix>
    <Product>Web OCR</Product>
    <Company>web-ocr</Company>
    <Copyright>© 2026</Copyright>
  </PropertyGroup>
</Project>
```

- Remove `<Version>/<AssemblyVersion>/<FileVersion>` from `server-csharp.csproj`; both C# projects inherit.
- Pre-release builds: `dotnet build -p:VersionSuffix=rc.1` → `1.4.0-rc.1`.
- Optional git SHA in `InformationalVersion` via a small MSBuild target (`git rev-parse --short HEAD`,
  guarded with `ContinueOnError` so tarball builds without git still work).
- The extension keeps its own `package.json` version scheme — unchanged, out of scope.

**Bump to `1.4.0`** for this feature (new capability, backwards compatible).

### 4.2 `VersionInfo` helper

`server/src/VersionInfo.cs`:

| Member | Value |
|--------|-------|
| `Semantic` | `"1.4.0"` — 3-part, from `AssemblyInformationalVersionAttribute`, SHA stripped |
| `Informational` | `"1.4.0+abc1234"` — full string |
| `Display` | `"Web OCR Server v1.4.0"` |

### 4.3 Where it shows up

| Surface | Change |
|---------|--------|
| Console banner (`Program.cs`) | Already prints a version — switch to `VersionInfo.Semantic` (drops the `.0`) |
| `/health` | `version` becomes the semantic string; add `informational_version` |
| GUI | Window title + an "About" line in the footer |
| `--version` flag | Prints `Display` and exits 0 |
| `CHANGELOG.md` (new, repo root) | Keep-a-Changelog format; `1.4.0` entry for this work |

---

## 5. Server refactor (Phase 2 — no GUI yet)

### 5.1 `ServerHost` — extract from `Program.cs`

`server/src/Hosting/ServerHost.cs`:

```csharp
public sealed record ServerOptions(
    int Port = 3579,
    BindMode Bind = BindMode.AnyIp,      // AnyIp | Localhost
    string? SocketPath = null,
    string? DataDir = null);

public sealed class ServerHost : IAsyncDisposable
{
    public ServerState State { get; }                  // Stopped|Starting|Running|Stopping|Faulted
    public event Action<ServerState>? StateChanged;
    public Task StartAsync(ServerOptions o, CancellationToken ct);
    public Task StopAsync(CancellationToken ct);
    public BootState? Boot { get; }                    // null while stopped
    public Uri? Url { get; }
}
```

`Program.cs` becomes: parse args → console mode calls `ServerHost` and blocks on `WaitForShutdownAsync`,
GUI mode hands the host to Avalonia. The Kestrel/CORS/pipeline/route wiring moves verbatim into
`ServerHost.Build()` — no behavioural change.

### 5.2 CLI parsing

`server/src/Cli/CliOptions.cs` — no new dependency, hand-rolled like `desktop/`'s style:

| Flag | Effect |
|------|--------|
| `--console`, `-c` | Force headless mode |
| `--gui` | Force GUI mode (error if no display) |
| `--port <n>`, `-p` | Override `PORT` |
| `--bind <any\|localhost>` | Override `BIND_ADDRESS` |
| `--socket <path>` | Override `SOCKET_PATH` (implies console) |
| `--data-dir <path>` | Override the data root |
| `--version`, `-V` / `--help`, `-h` | Print and exit |

Mode default: GUI when built for desktop **and** a display is detected
(`DISPLAY`/`WAYLAND_DISPLAY` on Linux, always on Windows/macOS); otherwise console.
Precedence everywhere: **CLI flag > env var > `.env` > persisted GUI settings > default.**

### 5.3 Bind mode

`AppConfig` gains `BindMode Bind` from `BIND_ADDRESS` (`0.0.0.0` | `any` → `AnyIp`;
`localhost` | `127.0.0.1` → `Localhost`; default `AnyIp`, preserving today's behaviour).
Kestrel: `ListenAnyIP(port)` vs `ListenLocalhost(port)`; `SOCKET_PATH` still wins when set.
The startup banner only prints LAN IPs in `AnyIp` mode.

### 5.4 Data directory resolution

Today: `CWD/data`. New order:

1. `--data-dir` flag
2. `DATA_DIR` env var
3. A `data/` folder **next to the executable** if it already exists (keeps current dev + Docker layout working)
4. `CWD/data` if it already exists (ditto)
5. Platform default, created on first run:
   - Windows `%LOCALAPPDATA%\WebOcr`
   - Linux `$XDG_DATA_HOME/web-ocr` → `~/.local/share/web-ocr`
   - macOS `~/Library/Application Support/WebOcr`

`.env` lookup follows the same precedence (exe dir, then CWD). The GUI shows the resolved path with an
"open folder" button — models are multi-GB, users will want to find them.

> **Care:** `CLAUDE.md` invariant — never pre-create `{dictDir}/extracted/`. Directory scaffolding in
> `BootBackgroundService` stays exactly as-is; only the *root* moves.

### 5.5 Log capture

`server/src/Hosting/LogBuffer.cs` — a bounded (~5 000 entry) ring buffer of
`(timestamp, level, category, message, exception)`, exposed as a singleton + an `event`.

- `LogBufferProvider : ILoggerProvider` registered alongside the console logger → captures all `ILogger` output.
- Raw `Console.Write*` calls (banner, `ModelDownloader` progress, `AppConfig` warnings): in GUI mode,
  `Console.SetOut`/`SetError` to a `TeeTextWriter` that forwards to the real stream **and** the buffer as
  `Information`/`Error`. Cheaper and safer than rewriting all 29 call sites now; converting them to
  `ILogger` can be a later cleanup.
- Download progress uses `\r` overwrite — the tee collapses `\r`-only updates into a single replaced line
  so the GUI log doesn't flood.

---

## 6. Desktop shell (Phase 3)

### 6.1 Layout

```
┌───────────────────────────────────────────────────────────┐
│ Web OCR Server v1.4.0                            [_][□][X]│
├───────────────────────────────────────────────────────────┤
│ ● Running   http://localhost:3579  [open]     models: ok   │  ← status bar
├───────────────────────────────────────────────────────────┤
│ Port [3579]  Bind [0.0.0.0 (all interfaces) ▾]  [Models…] │  ← config (disabled while running)
│ [ Start ] [ Stop ] [ Restart ]   ☑ Auto-start ☑ To tray   │
├───────────────────────────────────────────────────────────┤
│ 12:04:01 info  [Boot] Loading OCR models…                 │
│ 12:04:09 info  [Boot] OCR engine ready.                   │  ← log terminal, monospace,
│ 12:04:09 warn  Dictionary init failed — /health degraded   │    colour by level, auto-scroll
│ …                                                          │
├───────────────────────────────────────────────────────────┤
│ [Clear] [Copy] [Save…] ☑ Auto-scroll  Level [Info ▾]  data:│
│ ~/.local/share/web-ocr [open]                              │
└───────────────────────────────────────────────────────────┘
```

### 6.2 Status pill

| State | Source |
|-------|--------|
| ● Stopped (grey) | `ServerHost.State == Stopped` |
| ● Starting (amber) | `Running` + `BootState.IsReady == false` |
| ● Ready (green) | `IsReady`, all enabled models ready |
| ● Degraded (amber) | `IsReady` but an enabled model failed (same rule as `/health`) |
| ● Failed (red) | `Faulted` — e.g. port in use; message shown inline |

Driven by `BootState` polling on a 1 s `DispatcherTimer` (the flags are `volatile` — safe to read).

### 6.3 Files

```
server/
  Program.cs                     ← mode dispatch (rewritten, thin)
  src/Cli/CliOptions.cs          ← new
  src/Hosting/ServerHost.cs      ← new (extracted from Program.cs)
  src/Hosting/LogBuffer.cs       ← new
  src/Hosting/LogBufferProvider.cs, TeeTextWriter.cs, DataPaths.cs   ← new
  src/Shell/App.axaml(.cs)       ← new  Avalonia app (owns the TrayIcon)
  src/Shell/MainWindow.axaml(.cs)
  src/Shell/ShellViewModel.cs
  src/Shell/ModelSettingsWindow.axaml(.cs) + ModelSettingsViewModel.cs
  src/Shell/ShellSettings.cs     ← persisted to {dataDir}/shell-settings.json
  src/VersionInfo.cs             ← new
```

Reuses the `desktop/` project's conventions: `DelegateCommand`, hand-rolled `INotifyPropertyChanged`
view models, Fluent theme, Inter font, compiled bindings — no MVVM framework added.
Log list uses a virtualized `ItemsRepeater`/`ListBox` bound to an `ObservableCollection` capped at the
ring-buffer size, updated on the UI thread in batches (~100 ms) so a model download can't stall the UI.

### 6.4 Auto-start

`ShellSettings.AutoStart`, **default `true`**: the shell calls `ServerHost.StartAsync` as soon as the
window is shown, using the persisted port/bind (overridden by any `--port`/`--bind` flag). The status
pill goes amber immediately, so a first run — which downloads models — looks identical to console mode.
A failed auto-start (port in use) leaves the shell idle with a red pill and an actionable log line;
it never retries in a loop.

### 6.5 Tray icon

Avalonia's built-in `TrayIcon` (`App.axaml`), supported on Windows, macOS, and Linux under
`StatusNotifierItem` (GNOME needs an extension — degrade gracefully rather than crash if registration fails).

| Element | Behaviour |
|---------|-----------|
| Icon | Reflects state — grey stopped / amber starting / green ready / red failed |
| Tooltip | `Web OCR Server v1.4.0 — Ready — http://localhost:3579` |
| Left click | Show/restore + focus the main window |
| Menu | Open dashboard · Start · Stop · Restart · Show window · Quit |

`ShellSettings.MinimizeToTray` (default **on**): the window close button hides to tray instead of
exiting; **Quit** from the tray menu is the real exit and always stops the server gracefully first.
When tray registration is unavailable, close reverts to exit so the app can never become unkillable
from the UI. Lifetime stays `ShutdownMode.OnExplicitShutdown`, matching `desktop/Program.cs`.

### 6.6 Model settings window

A modal reached from **[Models…]**, wrapping the existing `ModelSettingsStore` / `PUT /api/settings`
contract — no new persistence format, no new endpoint.

- One section per model (OCR, Translate, Inpaint, Bubble): **Enabled**, **Repo**, **Local dir** (+ browse),
  **Files** (comma-separated), plus a read-only readiness badge from `BootState`.
- Reads `ModelSettingsStore.Current` directly in-process; writes through the same code path
  `PUT /api/settings` uses, so JSON persistence and validation stay in one place.
- Mirrors the server's existing semantics: **changes take effect on next restart.** The dialog says so
  and offers a **Save & Restart** button that saves then calls `ServerHost` restart.
- Dictionary (Jitendex) has no configurable repo — shown as a read-only status row.

### 6.7 Other behaviour details

- Single instance via a named `Mutex`, same pattern as `desktop/Program.cs`; a second launch reveals the
  existing window (via tray/window activation) instead of starting a second server.
- Port/bind inputs are disabled while running; Restart applies pending changes.
- Port validation: 1–65535; a bind failure surfaces as a red status + a log line, not a crash dialog.
- Quitting stops the server gracefully (`StopAsync` with a ~10 s timeout) before exit.
- Settings persisted: port, bind, auto-start, minimize-to-tray, log level filter, auto-scroll, window size.

---

## 7. Packaging (Phase 4)

`build/publish.sh` + `build/publish.ps1`, one command per RID:

```bash
dotnet publish server/server-csharp.csproj -c Release -r linux-x64 \
  --self-contained -p:PublishSingleFile=true \
  -p:IncludeNativeLibrariesForSelfExtract=true -o dist/linux-x64
```

| RID | Output | Notes |
|-----|--------|-------|
| `win-x64`, `win-arm64` | `WebOcrServer.exe` + `dist/` zip | `AttachConsole(ATTACH_PARENT_PROCESS)` for `--console`; `FreeConsole()` in GUI mode |
| `linux-x64`, `linux-arm64` | binary + `.desktop` file + tar.gz | Needs `libSkiaSharp`/`libe_sqlite3` native assets extracted |
| `osx-x64`, `osx-arm64` | `WebOcrServer.app` bundle + tar.gz | `Info.plist` + `LSUIElement=false`; unsigned for now — document the Gatekeeper right-click-open workaround |

Watch-outs:

- `bun run build` runs on every `Build` — CI/build machines need `bun`. Add `-p:SkipClientBuild=true`
  escape hatch and guard the target with a `Condition`.
- Single-file + ONNX Runtime / SkiaSharp / `e_sqlite3` natives **must** use
  `IncludeNativeLibrariesForSelfExtract`; verify OCR actually runs from the published binary (not just launches).
- Trimming (`PublishTrimmed`) is **off** — EF Core + reflection-heavy ONNX/Blazor paths make it risky.
  Expect ~120–180 MB self-contained per RID. Framework-dependent publish stays available for Docker.
- Models are **not** bundled; first run downloads them into the data dir, as today.

---

## 8. Phases

| # | Phase | Deliverable | Verify |
|---|-------|-------------|--------|
| 1 | Spike | Avalonia packages added to `server-csharp.csproj`, blank window opens, `dotnet run` still serves HTTP + Blazor | `dotnet build`; `/health` responds; Blazor page renders |
| 2 | Version + config | `Directory.Build.props`, `VersionInfo`, `CHANGELOG.md`, `--version/--help`, bind mode, data-dir resolution, `ServerHost` extraction | `dotnet run` unchanged; `--bind localhost` refuses LAN; `/health` shows `1.4.0` |
| 3a | Shell core | Avalonia window, log terminal, Start/Stop/Restart, port + bind inputs, status pill, auto-start, settings persistence | Manual run on Linux; start/stop 3× with no port leak or ONNX handle growth |
| 3b | Tray + models | `TrayIcon` with state-coloured icon and menu, minimize-to-tray, model settings window with Save & Restart | Tray works on Linux (SNI) and Windows; graceful fallback when unavailable; settings round-trip to `model-settings.json` |
| 4 | Packaging | publish scripts, per-RID artifacts, README + CLAUDE.md updates | Published binary runs OCR end-to-end on each OS available for testing |

Each phase ends with `dotnet build WebOcr.slnx` clean and is committed separately
(branch → single-commit PR → CodeRabbit review, per the repo's usual workflow).

---

## 9. Risks

| Risk | Mitigation |
|------|-----------|
| Avalonia XAML compiler misbehaves inside `Microsoft.NET.Sdk.Web` | Phase 1 spike is exactly this check; fall back to Option B if it fights back |
| In-process host restart leaks ONNX sessions / memory | `ServerHost` disposes the `WebApplication` fully; verify with repeated start/stop + RSS watch. `OcrEngine`/`TranslateService` must implement `IDisposable` if they don't already |
| Data-dir move breaks existing installs | Rules 3 & 4 keep any existing `data/` folder in place; only fresh installs get the platform path. Log the resolved path loudly at boot |
| Windows console/GUI duality is awkward | Standard `AttachConsole` pattern; if it proves flaky, ship `webocr-server.exe` (GUI) + `webocr-server-cli.exe` (console) from one build |
| Publish size / native-asset breakage | Verified per-RID in Phase 4 by actually running an OCR request, not just launching |
| GUI thread flooded by download progress | Batched UI updates + `\r` collapsing in the tee writer |
| Tray unsupported on the desktop environment (bare GNOME, some WMs) | Detect registration failure, log a warning, disable minimize-to-tray so close always exits |
| Model settings edited into an unbootable state (bad repo/file list) | Dialog validates non-empty repo + file list for enabled models; a failed download already degrades rather than crashes, and `/health` reports it |

---

## 10. Open questions

None blocking — all Phase 0 decisions are recorded at the top of this document.
Deferred by choice: installers, auto-update, and OS service installation (§1 non-goals).
