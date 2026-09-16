# Picker-dialog end-to-end test (ASCII-only source, same reason as capture.ps1).
#
#  T1 clipboard text          -> one queue line with the exact payload
#  T2 prompt file             -> dialog appears at the cursor (status.dialog.visible)
#  T3 click a user button     -> command {action:commit,user,id}
#  T4 nobody clicks           -> command {action:dismiss,id} after promptTimeoutMs
#  T5 click ignore            -> command {action:dismiss,id}
#  T6 text too long           -> ignored
#  T7 text without A-Za-z     -> ignored
#  T8 image in clipboard      -> exactly one image event
param([string]$PluginRoot)

$ErrorActionPreference = 'Stop'
if (-not $PluginRoot) { $PluginRoot = Split-Path -Parent $PSScriptRoot }

$work = Join-Path $env:TEMP ('wv-pick-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null
$queue = Join-Path $work 'capture-queue.jsonl'
$status = Join-Path $work 'capture-status.json'
$result = Join-Path $work 'capture-result.json'
$command = Join-Path $work 'capture-commands.jsonl'
$prompt = Join-Path $work 'capture-prompt.json'
$trigger = Join-Path $work 'capture-trigger.txt'
$dbg = Join-Path $work 'capture-debug.log'
$imgDir = Join-Path $work 'shots'
$cfg = Join-Path $work 'helper-config.json'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);

  // Buttons live inside a Panel, so a plain FindWindowEx (direct children only) misses
  // them: walk the whole descendant tree by window text instead.
  public static IntPtr FindDescendant(IntPtr parent, string text) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(parent, (h, l) => {
      var sb = new StringBuilder(256);
      GetWindowTextW(h, sb, 256);
      if (sb.ToString() == text) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool ClickButton(string dialogTitle, string buttonText) {
    IntPtr dlg = FindWindow(null, dialogTitle);
    if (dlg == IntPtr.Zero) return false;
    IntPtr btn = FindDescendant(dlg, buttonText);
    if (btn == IntPtr.Zero) return false;
    SendMessage(btn, 0x00F5, IntPtr.Zero, IntPtr.Zero); // BM_CLICK
    return true;
  }
}
'@

$sample = 'Animals and plants share the world with us.'
$long = ('word ' * 200)
$noLatin = '1234 --- 5678 ??? !!!'

$cfgObj = [ordered]@{
    queuePath = $queue; statusPath = $status; resultPath = $result; commandPath = $command
    promptPath = $prompt; triggerPath = $trigger; debugPath = $dbg; imageDir = $imgDir
    clipPollMs = 250; minLen = 2; maxLen = 400
    promptMode = $true; autoCommit = $false; defaultUser = 'user1'; promptTimeoutMs = 2500
    showDialog = $true; showFloatWindow = $false; floatOffsetX = 18; floatOffsetY = 90; floatAutoHide = $false
    debug = $true
    ui = @{
        title = 'WV'; ready = 'idle'; today = 'today {0}'
        promptTitle = 'record {0} word(s)'; promptEmpty = 'no english word'; promptMore = '... {0} more'
        ignoreLabel = 'ignore'; pending = 'working...'
        okTitle = 'OK saved'; okBody = '{0} word(s) -> {1}'; okToday = 'today total {0}'
        failTitle = 'FAILED'; ignored = 'ignored, nothing saved'
        emptyMsg = 'no text'; longMsg = 'text too long'; noWordMsg = 'no english word'
    }
    users = @(@{ name = 'user1'; enabled = $true }, @{ name = 'user2'; enabled = $true })
}
($cfgObj | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $cfg -Encoding UTF8

function ReadFileLines([string]$p) {
    for ($i = 0; $i -lt 5; $i++) {
        try {
            if (-not (Test-Path $p)) { return }
            return (Get-Content $p -Encoding UTF8 | ForEach-Object { $_.TrimStart([char]0xFEFF) } | Where-Object { $_.Trim() -ne '' })
        } catch {
            Start-Sleep -Milliseconds 80
        }
    }
}
function QueueText { ReadFileLines $queue | Where-Object { $_ -like '*"kind":"text"*' } }
function QueueImage { ReadFileLines $queue | Where-Object { $_ -like '*"kind":"image"*' } }
function Commands { ReadFileLines $command }
function CmdCount([string]$action, [string]$id) {
    return @(Commands | Where-Object { $_ -like ('*"action":"' + $action + '"*') -and $_ -like ('*"' + $id + '"*') }).Count
}
function Status {
    # the helper replaces status.json atomically (temp + move): a reader can catch the
    # instant where the file is held, so retry instead of throwing
    for ($i = 0; $i -lt 6; $i++) {
        try {
            if (Test-Path $status) { return (Get-Content $status -Raw -Encoding UTF8 | ConvertFrom-Json) }
            return $null
        } catch {
            Start-Sleep -Milliseconds 90
        }
    }
    return $null
}
function Wait-For([scriptblock]$cond, [int]$timeoutMs = 6000) {
    $end = (Get-Date).AddMilliseconds($timeoutMs)
    while ((Get-Date) -lt $end) {
        if (& $cond) { return $true }
        Start-Sleep -Milliseconds 150
    }
    return $false
}
function Write-Prompt([string]$id, [string[]]$words) {
    $o = [ordered]@{ id = $id; at = (Get-Date).ToString('s'); wordCount = $words.Count; words = $words; preview = 'test' }
    ($o | ConvertTo-Json -Compress) | Set-Content -LiteralPath $prompt -Encoding UTF8
}
function DumpLog([string]$tag) {
    Write-Output ("--- debug @ $tag ---")
    if (Test-Path $dbg) { Get-Content $dbg -Encoding UTF8 | Select-Object -Last 14 | ForEach-Object { Write-Output $_ } }
}

[System.Windows.Forms.Clipboard]::Clear()
Start-Sleep -Milliseconds 400

$ps = Join-Path $PluginRoot 'scripts\capture.ps1'
$helper = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ps, '-ConfigPath', $cfg
) -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
Write-Output ("helper pid={0} exited={1}" -f $helper.Id, $helper.HasExited)

$ok = $true
function Verdict([string]$name, $pass, [string]$detail) {
    if ($pass -eq $true) { Write-Output "PASS $name" } else { Write-Output "FAIL $name ($detail)"; $script:ok = $false }
}

# ---- T1 clipboard -> queue
[System.Windows.Forms.Clipboard]::SetText($sample)
$null = Wait-For { @(QueueText).Count -ge 1 }
$lines = @(QueueText)
Verdict 'T1 clipboard text queued' ($lines.Count -eq 1) ("lines=" + $lines.Count)
if ($lines.Count -ge 1) {
    $e = $lines[0] | ConvertFrom-Json
    Verdict 'T1 payload exact' ($e.text -eq $sample -and $e.via -eq 'clipboard') ("via=" + $e.via)
}

# ---- T2 prompt -> dialog appears at the cursor
Write-Prompt 'p-test-1' @('plant', 'world')
$shown = Wait-For { $s = Status; $s -and $s.dialog -and $s.dialog.visible -eq $true }
$st = Status
Verdict 'T2 dialog shown on prompt' $shown ('status=' + (($st | ConvertTo-Json -Compress) -replace '\s+', ' '))
$title = ''
if ($st -and $st.dialog) { $title = [string]$st.dialog.title }
Verdict 'T2 dialog title has count' ($title -like '*2*') ("title=" + $title)

# ---- T3 click user1 -> commit command
$clicked = $false
if ($title) { $clicked = [Win]::ClickButton('word-vault-picker', 'user1') }
Verdict 'T3 user button found and clicked' $clicked 'button lookup failed'
$null = Wait-For { (CmdCount 'commit' 'p-test-1') -ge 1 }
Verdict 'T3 commit command written' ((CmdCount 'commit' 'p-test-1') -eq 1) ("cmds=" + (@(Commands) -join ' | '))
$cmds = @(Commands)
if ($cmds.Count -ge 1) {
    $c = $cmds[0] | ConvertFrom-Json
    Verdict 'T3 commit carries user' ($c.user -eq 'user1' -and $c.id -eq 'p-test-1') ("user=" + $c.user)
}

# ---- T3b host result -> dialog switches to success + today total, then auto-hides
$resObj = [ordered]@{ at = (Get-Date).ToString('s'); ok = $true; message = '4 word(s) -> user1'
    todayCount = 12; user = 'user1'; kind = 'commit'; id = 'p-test-1' }
($resObj | ConvertTo-Json -Compress) | Set-Content -LiteralPath $result -Encoding UTF8

$switched = Wait-For { $s = Status; $s -and $s.dialog -and ([string]$s.dialog.title) -like 'OK*' }
$st = Status
Verdict 'T3b dialog shows success' $switched ("title=" + [string]$st.dialog.title)
Verdict 'T3b today total taken from host' ([int]$st.todayCount -eq 12) ("today=" + $st.todayCount)
$hidden = Wait-For { $s = Status; $s -and $s.dialog -and $s.dialog.visible -eq $false } 5000
Verdict 'T3b dialog auto-hides after result' $hidden ("visible=" + (Status).dialog.visible)
    # result state: the secondary button must read OK, not ignore
    $clickedOk = [Win]::ClickButton('word-vault-picker', 'OK')
    Verdict 'result button says OK' $clickedOk 'expected OK label on the result-state button'

# ---- T4 nobody clicks -> dismiss after promptTimeoutMs
Write-Prompt 'p-test-2' @('share')
$null = Wait-For { $s = Status; $s -and $s.dialog -and $s.dialog.visible -eq $true }
$null = Wait-For { (CmdCount 'dismiss' 'p-test-2') -ge 1 } 8000
Verdict 'T4 timeout writes dismiss' ((CmdCount 'dismiss' 'p-test-2') -eq 1) ("cmds=" + (@(Commands) -join ' | '))
$st = Status
Verdict 'T4 dialog hidden after timeout' ($st.dialog.visible -eq $false) ("visible=" + $st.dialog.visible)

# ---- T5 click ignore -> dismiss
Write-Prompt 'p-test-3' @('map')
$null = Wait-For { $s = Status; $s -and $s.dialog -and $s.dialog.visible -eq $true }
$clickedIgnore = [Win]::ClickButton('word-vault-picker', 'ignore')
Verdict 'T5 ignore button clicked' $clickedIgnore 'button lookup failed'
$null = Wait-For { (CmdCount 'dismiss' 'p-test-3') -ge 1 }
Verdict 'T5 ignore writes dismiss' ((CmdCount 'dismiss' 'p-test-3') -eq 1) ("cmds=" + (@(Commands) -join ' | '))

# ---- T6/T7 filters
$before = @(QueueText).Count
[System.Windows.Forms.Clipboard]::SetText($long)
Start-Sleep -Milliseconds 1200
Verdict 'T6 long text ignored' (@(QueueText).Count -eq $before) ("before=$before after=" + @(QueueText).Count)
[System.Windows.Forms.Clipboard]::SetText($noLatin)
Start-Sleep -Milliseconds 1200
Verdict 'T7 no-latin ignored' (@(QueueText).Count -eq $before) ("lines=" + @(QueueText).Count)

# ---- T8 image
$imgBefore = @(QueueImage).Count
$bmp = New-Object System.Drawing.Bitmap 120, 40
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.DrawString('hi', (New-Object System.Drawing.Font('Arial', 14)), [System.Drawing.Brushes]::Black, 4, 8)
$g.Dispose()
[System.Windows.Forms.Clipboard]::SetImage($bmp)
$null = Wait-For { @(QueueImage).Count -gt $imgBefore }
Start-Sleep -Milliseconds 1200
Verdict 'T8 image queued once' (@(QueueImage).Count -eq $imgBefore + 1) ("before=$imgBefore after=" + @(QueueImage).Count)

Stop-Process -Id $helper.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400
Write-Output ("== RESULT: " + $(if ($ok) { 'ALL PASS' } else { 'FAILURES' }))
Write-Output ("== work dir: $work")
Write-Output '--- queue ---'
ReadFileLines $queue | ForEach-Object { $_.Substring(0, [Math]::Min(130, $_.Length)) }
Write-Output '--- commands ---'
Commands | ForEach-Object { Write-Output $_ }
DumpLog 'final'
