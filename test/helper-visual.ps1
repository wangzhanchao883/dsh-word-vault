# Visual + drag verification for the chip and the picker dialog (ASCII-only source).
#   V1 chip renders: white card body, soft-yellow "today" pill, dark text, blue border
#   V2 dialog renders: white body, soft-blue title strip, dark text
#   V3 dragging the chip moves it by the mouse delta AND persists chip-pos.json
# The helper reports its real window rectangles in capture-status.json, so every sample
# point is derived from measured geometry instead of guessed coordinates.
param([string]$PluginRoot)

$ErrorActionPreference = 'Stop'
if (-not $PluginRoot) { $PluginRoot = Split-Path -Parent $PSScriptRoot }

$work = Join-Path $env:TEMP ('wv-vis-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null
$chipPos = Join-Path $work 'chip-pos.json'
$status = Join-Path $work 'capture-status.json'
$prompt = Join-Path $work 'capture-prompt.json'
$dbg = Join-Path $work 'd.log'
$cfg = Join-Path $work 'helper-config.json'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Vis {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static IntPtr MakeLParam(int x, int y) { return (IntPtr)((y << 16) | (x & 0xFFFF)); }
}
public class F2 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static IntPtr FindCard(uint pid, int w, int h) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((win, l) => {
      uint p; GetWindowThreadProcessId(win, out p);
      if (p == pid) { RECT r; GetWindowRect(win, out r); if ((r.R - r.L) == w && (r.B - r.T) == h) { found = win; return false; } }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
[void][Vis]::SetProcessDPIAware()

$cfgObj = [ordered]@{
    queuePath = (Join-Path $work 'q.jsonl'); statusPath = $status
    resultPath = (Join-Path $work 'r.json'); commandPath = (Join-Path $work 'c.jsonl')
    promptPath = $prompt; triggerPath = (Join-Path $work 't.txt'); debugPath = $dbg
    imageDir = ''; clipPollMs = 300; minLen = 2; maxLen = 400
    promptMode = $true; autoCommit = $false; defaultUser = 'user1'; promptTimeoutMs = 60000
    showDialog = $true; showFloatWindow = $true; floatOffsetX = 40; floatOffsetY = 40; floatAutoHide = $false
    debug = $true
    ui = @{
        title = 'Word Vault'; ready = 'watching clipboard'; today = 'today {0} words'
        promptTitle = 'record {0} word(s)'; promptEmpty = 'no english word'; promptMore = '... {0} more'
        ignoreLabel = 'ignore'; pending = 'working...'
        okTitle = 'OK saved'; okBody = '{0} word(s) -> {1}'; okToday = 'today total {0}'
        failTitle = 'FAILED'; ignored = 'ignored, nothing saved'
        emptyMsg = 'no text'; longMsg = 'text too long'; noWordMsg = 'no english word'
    }
    users = @(@{ name = 'user1'; enabled = $true }, @{ name = 'user2'; enabled = $true })
}
($cfgObj | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $cfg -Encoding UTF8

function Status { for ($i = 0; $i -lt 8; $i++) { try { if (Test-Path $status) { return (Get-Content $status -Raw -Encoding UTF8 | ConvertFrom-Json) } } catch { }; Start-Sleep -Milliseconds 90 }; return $null }
function Shot([int]$x, [int]$y, [int]$w, [int]$h, [string]$name) {
    if ($x -lt 0) { $x = 0 }; if ($y -lt 0) { $y = 0 }
    if (($x + $w) -gt ([System.Windows.Forms.SystemInformation]::VirtualScreen.Width)) { $w = [System.Windows.Forms.SystemInformation]::VirtualScreen.Width - $x }
    if (($y + $h) -gt ([System.Windows.Forms.SystemInformation]::VirtualScreen.Height)) { $h = [System.Windows.Forms.SystemInformation]::VirtualScreen.Height - $y }
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    $g.Dispose()
    $p = Join-Path $work $name
    $bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return $p
}
function Near($c, [int]$r, [int]$g, [int]$b, [int]$tol = 12) {
    return ([Math]::Abs($c.R - $r) -le $tol) -and ([Math]::Abs($c.G - $g) -le $tol) -and ([Math]::Abs($c.B - $b) -le $tol)
}
function Rgb($c) { return ($c.R.ToString() + "," + $c.G.ToString() + "," + $c.B.ToString()) }

$ps = Join-Path $PluginRoot 'scripts\capture.ps1'
$helper = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ps, '-ConfigPath', $cfg) -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3

$ok = $true
function Verdict([string]$name, $pass, [string]$detail) {
    if ($pass -eq $true) { Write-Output "PASS $name" } else { Write-Output "FAIL $name ($detail)"; $script:ok = $false }
}

$st = Status
Verdict 'V0 helper reports geometry' ($st -and $st.chip -and $st.chip.width -gt 0) ("status=" + (($st | ConvertTo-Json -Compress) -replace '\s+', ' '))
$cx = [int]$st.chip.left; $cy = [int]$st.chip.top; $cw = [int]$st.chip.width; $ch = [int]$st.chip.height
Write-Output ("== chip rect = {0},{1} {2}x{3}" -f $cx, $cy, $cw, $ch)

# ---------------- V1 chip look (samples derived from the measured rect)
$chipShot = Shot $cx $cy $cw $ch 'chip.png'
$img = [System.Drawing.Image]::FromFile($chipShot)
$body = $img.GetPixel(60, $ch - 8)                 # bottom band = white card
$pill = $img.GetPixel(($cw - 16), 30)              # today pill background (away from the text)
$border = $img.GetPixel([int]($cw / 2), 0)         # top edge = blue border
$dark = 0
for ($x = 4; $x -lt ($cw - 4); $x++) { for ($y = 4; $y -lt ($ch - 4); $y++) { $c = $img.GetPixel($x, $y); if ($c.R -lt 80 -and $c.G -lt 80 -and $c.B -lt 80) { $dark++ } } }
Verdict 'V1 chip body is white' (Near $body 255 255 255 8) ("rgb=" + (Rgb $body))
Verdict 'V1 today pill is soft yellow' (Near $pill 255 243 196 14) ("rgb=" + (Rgb $pill))
Verdict 'V1 chip has light-blue border' (Near $border 143 196 232 26) ("rgb=" + (Rgb $border))
Verdict 'V1 chip renders dark text' ($dark -gt 80) ("darkPx=" + $dark)
$img.Dispose()

# ---------------- V2 dialog look
[ordered]@{ id = 'v-test'; at = (Get-Date).ToString('s'); wordCount = 3; words = @('plant', 'world', 'share'); preview = 'x' } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $prompt -Encoding UTF8
$shown = $false
for ($i = 0; $i -lt 24; $i++) { $s = Status; if ($s -and $s.dialog -and $s.dialog.visible) { $shown = $true; break }; Start-Sleep -Milliseconds 250 }
Verdict 'V2 dialog shown' $shown 'dialog never became visible'
$st = Status
$dx = [int]$st.dialog.left; $dy = [int]$st.dialog.top; $dw = [int]$st.dialog.width; $dh = [int]$st.dialog.height
Write-Output ("== dialog rect = {0},{1} {2}x{3}" -f $dx, $dy, $dw, $dh)
Start-Sleep -Milliseconds 500
$dlgShot = Shot $dx $dy $dw $dh 'dialog.png'
$dimg = [System.Drawing.Image]::FromFile($dlgShot)
$strip = $dimg.GetPixel([int]($dw / 2), 10)        # title strip (soft blue)
$dbody = $dimg.GetPixel([int]($dw / 2), 50)        # body (white)
$btn = $dimg.GetPixel(20, ($dh - 24))              # user button background (left of its label)
$dborder = $dimg.GetPixel([int]($dw / 2), 0)       # border
Verdict 'V2 title strip is soft blue' (Near $strip 232 242 251 12) ("rgb=" + (Rgb $strip))
Verdict 'V2 dialog body is white' (Near $dbody 255 255 255 8) ("rgb=" + (Rgb $dbody))
Verdict 'V2 user button is soft blue' (Near $btn 232 242 251 14) ("rgb=" + (Rgb $btn))
Verdict 'V2 dialog has light-blue border' (Near $dborder 143 196 232 26) ("rgb=" + (Rgb $dborder))
$dimg.Dispose()

# ---------------- V3 drag the chip by a known delta and check the arithmetic
$card = [F2]::FindCard([uint32]$helper.Id, $cw, $ch)
Verdict 'V3 chip window found' ($card -ne [IntPtr]::Zero) 'no matching window size in helper process'
if ($card -ne [IntPtr]::Zero) {
    $grabX = $cx + [int]($cw / 2); $grabY = $cy + 14
    [void][Vis]::SetCursorPos($grabX, $grabY)
    Start-Sleep -Milliseconds 300
    [void][Vis]::SendMessage($card, 0x0201, [IntPtr]1, [Vis]::MakeLParam(($cw / 2), 14))   # WM_LBUTTONDOWN
    Start-Sleep -Milliseconds 300
    $moveX = 130; $moveY = 90
    [void][Vis]::SetCursorPos(($grabX + $moveX), ($grabY + $moveY))
    Start-Sleep -Milliseconds 300
    [void][Vis]::SendMessage($card, 0x0200, [IntPtr]1, [Vis]::MakeLParam(($cw / 2 + $moveX), (14 + $moveY)))  # WM_MOUSEMOVE
    Start-Sleep -Milliseconds 300
    [void][Vis]::SendMessage($card, 0x0202, [IntPtr]0, [Vis]::MakeLParam(($cw / 2 + $moveX), (14 + $moveY)))  # WM_LBUTTONUP
    # the chip publishes its rect on drop, but let the writer land before reading
    $moved = $false
    for ($i = 0; $i -lt 30; $i++) { $s2 = Status; if ($s2 -and ([int]$s2.chip.left -ne $cx -or [int]$s2.chip.top -ne $cy)) { $moved = $true; break }; Start-Sleep -Milliseconds 250 }
    $st2 = Status
    $nx = [int]$st2.chip.left; $ny = [int]$st2.chip.top
    $adx = $nx - $cx; $ady = $ny - $cy
    Verdict 'V3 drag moved the chip by the mouse delta' (([Math]::Abs($adx - $moveX) -le 10) -and ([Math]::Abs($ady - $moveY) -le 10)) ("moved dx=$adx dy=$ady expected $moveX/$moveY published=" + $moved)
    $saved = $null
    if (Test-Path $chipPos) { $saved = Get-Content $chipPos -Raw -Encoding UTF8 | ConvertFrom-Json }
    Verdict 'V3 new position persisted' ($saved -and ([int]$saved.left -eq $nx) -and ([int]$saved.top -eq $ny)) ("saved=" + (($saved | ConvertTo-Json -Compress)))
    [void](Shot $nx $ny $cw $ch 'chip-after-drag.png')
}

Stop-Process -Id $helper.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400
Write-Output ("== RESULT: " + $(if ($ok) { 'ALL PASS' } else { 'FAILURES' }))
Write-Output ("== screenshots: " + $work)
