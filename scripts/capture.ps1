# dsh-word-vault clipboard watcher + picker dialog  (ASCII-only source on purpose)
#
# WHY ASCII: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so non-ASCII
# literals get mangled and break parsing. All user-facing text comes from the
# UTF-8 JSON config written by the host.
#
# FLOW (confirmed with the user 2026-09-16; an explicit click = no junk recorded)
#   Ctrl+C -> helper queues the text -> host extracts words -> writes capture-prompt.json
#          -> helper pops a dialog AT THE MOUSE with one button per user
#          -> click -> command commit -> host records -> result shows "done + today total"
#          -> timeout / ignore -> command dismiss -> nothing recorded
#   autoCommit=true keeps the old "record straight into defaultUser" behaviour.
#
# FILE PROTOCOL (PowerShell stdout does not reliably return on this machine)
#   queuePath    helper -> host : JSONL {ts,kind:'text'|'image',text,imagePath,via,user}
#   commandPath  helper -> host : JSONL {ts,action:'commit'|'dismiss',id,user}
#   promptPath   host -> helper : {id,at,wordCount,words[],preview}
#   resultPath   host -> helper : {at,ok,message,todayCount,user,kind,id}
#   statusPath   helper -> host : helper state (incl. dialog visibility/title for tests)
#   triggerPath  host -> helper : text file holding a user name -> force one capture
#   debugPath    helper -> host : debug log (only when config.debug = true)
#
# USAGE: powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File capture.ps1 -ConfigPath <cfg.json>

param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [switch]$NoWindow
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- config

if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "config not found: $ConfigPath" }
$cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

$queuePath = [string]$cfg.queuePath
$statusPath = [string]$cfg.statusPath
$resultPath = [string]$cfg.resultPath
$commandPath = [string]$cfg.commandPath
$promptPath = [string]$cfg.promptPath
$triggerPath = [string]$cfg.triggerPath
$imageDir = [string]$cfg.imageDir
$clipPollMs = if ($cfg.clipPollMs) { [int]$cfg.clipPollMs } else { 350 }
$minLen = if ($null -ne $cfg.minLen) { [int]$cfg.minLen } else { 2 }
$maxLen = if ($null -ne $cfg.maxLen) { [int]$cfg.maxLen } else { 400 }
$promptMode = [bool]$cfg.promptMode
$autoCommit = [bool]$cfg.autoCommit
$defaultUser = if ($cfg.defaultUser) { [string]$cfg.defaultUser } else { '' }
$promptTimeoutMs = if ($null -ne $cfg.promptTimeoutMs) { [int]$cfg.promptTimeoutMs } else { 20000 }
$showDialog = [bool]$cfg.showDialog
$showChip = (-not $NoWindow) -and ([bool]$cfg.showFloatWindow)
$offsetX = if ($null -ne $cfg.floatOffsetX) { [int]$cfg.floatOffsetX } else { 18 }
$offsetY = if ($null -ne $cfg.floatOffsetY) { [int]$cfg.floatOffsetY } else { 90 }
$autoHide = [bool]$cfg.floatAutoHide
$debug = [bool]$cfg.debug
$debugPath = if ($cfg.debugPath) { [string]$cfg.debugPath } else { "$statusPath.debug.log" }
$startedAt = (Get-Date).ToString('s')

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-TextFile([string]$path, [string]$text) { [System.IO.File]::WriteAllText($path, $text, $utf8NoBom) }
function Append-TextFile([string]$path, [string]$text) { [System.IO.File]::AppendAllText($path, $text, $utf8NoBom) }
function Write-DebugLog([string]$m) {
    if (-not $debug) { return }
    try { Append-TextFile $debugPath (("{0} {1}`r`n" -f (Get-Date).ToString('HH:mm:ss.fff'), $m)) } catch { }
}

# UI strings from config so this file stays pure ASCII
$ui = [ordered]@{
    title = 'Word Vault'; ready = 'watching clipboard'; today = 'today {0}'
    promptTitle = 'record {0} word(s)'; promptEmpty = 'no english word'; promptMore = '... {0} more'
    ignoreLabel = 'ignore'; pending = 'working...'
    okTitle = 'OK saved'; okBody = '{0} word(s) -> {1}'; okToday = 'today total {0}'
    failTitle = 'FAILED'; ignored = 'ignored, nothing saved'
    emptyMsg = 'no text'; longMsg = 'text too long'; noWordMsg = 'no english word'
}
if ($cfg.ui) {
    foreach ($k in @($ui.Keys)) {
        if ($cfg.ui.PSObject.Properties.Name -contains $k) { $ui[$k] = [string]$cfg.ui.$k }
    }
}

$userList = @()
foreach ($u in $cfg.users) {
    if ($u -and $u.enabled -ne $false) { $userList += [string]$u.name }
}
if ($userList.Count -eq 0) { throw 'no enabled user in config' }

# ---------------------------------------------------------------- win32 / winforms

$csharp = @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class WvClip {
    // The OS increments this on every clipboard change: exact and far cheaper than
    // hashing content on every poll (a screenshot PNG-encode per poll is not free).
    [DllImport("user32.dll")]
    public static extern uint GetClipboardSequenceNumber();

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    // CRITICAL on scaled displays (this machine is 1920x1080 @125%): a DPI-unaware
    // process gets virtualized coordinates, so Form.Left/Top no longer match physical
    // pixels -> dragging teleports the window and the default corner placement is off.
    // Must be called before the first window is created.
    public static void MakeDpiAware() {
        try { SetProcessDPIAware(); } catch { }
    }
}

// Always-on-top window that NEVER takes focus, so its buttons can be clicked
// without stealing the selection or the caret from whatever app has it.
public class WvNoActivateForm : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
            cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
            return cp;
        }
    }
}
'@
Add-Type -TypeDefinition $csharp -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing' -ErrorAction Stop

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# flatten the process to 1:1 pixels BEFORE any window exists (see MakeDpiAware note)
[WvClip]::MakeDpiAware()

# ---------------------------------------------------------------- state

$script:lastSeq = 0
$script:lastText = ''
$script:lastTextAt = (Get-Date).AddMinutes(-5)
$script:lastCapture = [string]$ui.ready
$script:lastError = ''
$script:clipLen = 0
$script:todayCount = 0
$script:chip = $null
$script:chipToday = $null
$script:chipMsg = $null
$script:dlg = $null
$script:dlgTitle = $null
$script:dlgBody = $null
$script:dlgStatus = $null
$script:dlgButtons = @{}
$script:dlgVisible = $false
$script:promptId = ''
$script:promptShownAt = $null
$script:pendingCommit = $false
$script:resultShownAt = $null
$script:lastPromptSeen = ''
$script:lastResultStamp = ''

function Write-Status {
    $o = [ordered]@{
        ready       = $true
        pid         = $PID
        startedAt   = $startedAt
        updatedAt   = (Get-Date).ToString('s')
        mode        = $(if ($promptMode) { 'clipboard-pick' } else { 'clipboard-watch' })
        users       = @($userList)
        promptMode  = $promptMode
        autoCommit  = $autoCommit
        todayCount  = $script:todayCount
        clipLen     = $script:clipLen
        lastError   = $script:lastError
        lastCapture = $script:lastCapture
        chip        = [ordered]@{
            visible = [bool]($script:chip -and $script:chip.Visible)
            left    = $(if ($script:chip) { $script:chip.Left } else { 0 })
            top     = $(if ($script:chip) { $script:chip.Top } else { 0 })
            width   = $(if ($script:chip) { $script:chip.Width } else { 0 })
            height  = $(if ($script:chip) { $script:chip.Height } else { 0 })
        }
        dialog      = [ordered]@{
            visible = $script:dlgVisible
            title   = $script:dlgTitleText
            promptId = $script:promptId
            left    = $(if ($script:dlg) { $script:dlg.Left } else { 0 })
            top     = $(if ($script:dlg) { $script:dlg.Top } else { 0 })
            width   = $(if ($script:dlg) { $script:dlg.Width } else { 0 })
            height  = $(if ($script:dlg) { $script:dlg.Height } else { 0 })
        }
    }
    $tmp = "$statusPath.tmp"
    try {
        Write-TextFile $tmp ($o | ConvertTo-Json -Depth 4 -Compress)
        Move-Item -LiteralPath $tmp -Destination $statusPath -Force
    } catch { }
}

function Get-HostResult {
    if (-not $resultPath -or -not (Test-Path -LiteralPath $resultPath)) { return $null }
    try { return (Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Get-Prompt {
    if (-not $promptPath -or -not (Test-Path -LiteralPath $promptPath)) { return $null }
    try { return (Get-Content -LiteralPath $promptPath -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Add-QueueLine([hashtable]$obj) {
    Append-TextFile $queuePath (($obj | ConvertTo-Json -Compress) + "`r`n")
    Write-DebugLog ("QUEUED " + ($obj | ConvertTo-Json -Compress))
}

function Add-CommandLine([string]$action, [string]$id, [string]$user) {
    $line = ([ordered]@{ ts = (Get-Date).ToString('s'); action = $action; id = $id; user = $user } | ConvertTo-Json -Compress)
    Append-TextFile $commandPath ($line + "`r`n")
    Write-DebugLog ("COMMAND " + $line)
}

# ---------------------------------------------------------------- windows

function Get-CursorScreen {
    $p = [System.Windows.Forms.Cursor]::Position
    return [System.Windows.Forms.Screen]::FromPoint($p)
}

function Place-NearCursor($form) {
    $scr = Get-CursorScreen
    $p = [System.Windows.Forms.Cursor]::Position
    $wa = $scr.WorkingArea
    $left = $p.X + 14
    $top = $p.Y + 18
    $left = [Math]::Min([Math]::Max($left, $wa.Left), $wa.Right - $form.Width)
    $top = [Math]::Min([Math]::Max($top, $wa.Top), $wa.Bottom - $form.Height)
    $form.Left = $left
    $form.Top = $top
}

# ---- light palette: white card, soft blue + soft yellow, black text (user request 2026-09-16)
$CLR = @{
    white       = [System.Drawing.Color]::FromArgb(255, 255, 255)
    borderBlue  = [System.Drawing.Color]::FromArgb(143, 196, 232)
    softBlue    = [System.Drawing.Color]::FromArgb(232, 242, 251)
    softYellow  = [System.Drawing.Color]::FromArgb(255, 243, 196)
    black       = [System.Drawing.Color]::FromArgb(26, 26, 26)
    grayText    = [System.Drawing.Color]::FromArgb(85, 85, 85)
    blueText    = [System.Drawing.Color]::FromArgb(31, 111, 178)
    greenText   = [System.Drawing.Color]::FromArgb(23, 128, 74)
}

# ---- chip position is remembered between runs (so a moved chip stays moved)
$chipPosPath = Join-Path (Split-Path -Parent $statusPath) 'chip-pos.json'
$script:dragTarget = $null
$script:dragOffset = $null

function Get-SavedChipPos {
    try {
        if (-not (Test-Path -LiteralPath $chipPosPath)) { return $null }
        $o = Get-Content -LiteralPath $chipPosPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -eq $o.left -or $null -eq $o.top) { return $null }
        $left = [int]$o.left; $top = [int]$o.top
        $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
        # off the virtual desktop (monitor/resolution changed) -> fall back to the default corner
        if ($left -lt $vs.Left -or $left -gt ($vs.Right - 40) -or $top -lt $vs.Top -or $top -gt ($vs.Bottom - 40)) { return $null }
        return @{ left = $left; top = $top }
    } catch { return $null }
}

function Save-ChipPos {
    if (-not $script:chip) { return }
    try {
        Write-TextFile $chipPosPath (([ordered]@{ left = $script:chip.Left; top = $script:chip.Top }) | ConvertTo-Json -Compress)
    } catch { }
}

# ---- drag anywhere on the card: track by cursor delta so fast drags outside the
#      control still work (Capture keeps MouseMove coming to the grabbed control)
function Enable-Drag($controls) {
    $down = {
        param($s, $e)
        if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
            $f = $s.FindForm()
            if (-not $f) { return }
            $script:dragTarget = $f
            $p = [System.Windows.Forms.Cursor]::Position
            $script:dragOffset = New-Object System.Drawing.Point(($p.X - $f.Left), ($p.Y - $f.Top))
            $s.Capture = $true
        }
    }
    $move = {
        param($s, $e)
        if ($script:dragOffset -and $script:dragTarget) {
            $p = [System.Windows.Forms.Cursor]::Position
            $script:dragTarget.Left = $p.X - $script:dragOffset.X
            $script:dragTarget.Top = $p.Y - $script:dragOffset.Y
        }
    }
    $up = {
        param($s, $e)
        if ($script:dragOffset) {
            $script:dragOffset = $null
            $s.Capture = $false
            Save-ChipPos
            Write-Status      # publish the new rect right away (host/tests read it)
        }
    }
    foreach ($c in $controls) {
        $c.Add_MouseDown($down)
        $c.Add_MouseMove($move)
        $c.Add_MouseUp($up)
    }
}

function Build-Chip {
    $f = New-Object WvNoActivateForm
    $f.FormBorderStyle = 'None'
    $f.TopMost = $true
    $f.ShowInTaskbar = $false
    $f.StartPosition = 'Manual'
    $f.Width = 232
    $f.Height = 70
    $f.BackColor = $CLR.borderBlue      # 1px visual border (white card covers the middle)
    $f.Opacity = 0.97

    $card = New-Object System.Windows.Forms.Panel
    $card.Left = 1; $card.Top = 1; $card.Width = $f.Width - 2; $card.Height = $f.Height - 2
    $card.BackColor = $CLR.white
    $f.Controls.Add($card)

    $t = New-Object System.Windows.Forms.Label
    $t.Text = [string]$ui.title
    $t.ForeColor = $CLR.blueText
    $t.BackColor = $CLR.white
    $t.Font = New-Object System.Drawing.Font('Microsoft YaHei', 7.5)
    $t.Left = 7; $t.Top = 5; $t.Width = 218; $t.Height = 15
    $card.Controls.Add($t)

    $c = New-Object System.Windows.Forms.Label
    $c.Text = ($ui.today -f 0)
    $c.ForeColor = $CLR.black
    $c.BackColor = $CLR.softYellow
    $c.Font = New-Object System.Drawing.Font('Microsoft YaHei', 8.5, [System.Drawing.FontStyle]::Bold)
    $c.Left = 7; $c.Top = 22; $c.Width = 218; $c.Height = 19
    $c.TextAlign = 'MiddleLeft'
    $card.Controls.Add($c)

    $m = New-Object System.Windows.Forms.Label
    $m.Text = [string]$ui.ready
    $m.ForeColor = $CLR.grayText
    $m.BackColor = $CLR.white
    $m.Font = New-Object System.Drawing.Font('Microsoft YaHei', 7)
    $m.Left = 7; $m.Top = 44; $m.Width = 218; $m.Height = 20
    $card.Controls.Add($m)

    if ($autoHide) {
        $f.Add_MouseEnter({ $script:chip.Opacity = 0.97 })
        $f.Add_MouseLeave({ $script:chip.Opacity = 0.45 })
    }

    $saved = Get-SavedChipPos
    if ($saved) {
        $f.Left = $saved.left
        $f.Top = $saved.top
    } else {
        $scr = [System.Windows.Forms.Screen]::PrimaryScreen
        $f.Left = $scr.WorkingArea.Right - $f.Width - $offsetX
        $f.Top = $scr.WorkingArea.Top + $offsetY
    }
    $f.Show()
    $script:chip = $f
    $script:chipToday = $c
    $script:chipMsg = $m
    Enable-Drag @($f, $card, $t, $c, $m)
    Write-DebugLog ("CHIP at {0},{1} (saved={2})" -f $f.Left, $f.Top, [bool]$saved)
}

$script:dlgTitleText = ''

function Build-Dialog {
    $f = New-Object WvNoActivateForm
    $f.FormBorderStyle = 'None'
    $f.TopMost = $true
    $f.ShowInTaskbar = $false
    $f.StartPosition = 'Manual'
    $f.Width = 330
    $f.Height = 134
    $f.BackColor = $CLR.borderBlue      # 1px visual border
    $f.Opacity = 0.99
    $f.Text = 'word-vault-picker'

    $inner = New-Object System.Windows.Forms.Panel
    $inner.Left = 1; $inner.Top = 1; $inner.Width = $f.Width - 2; $inner.Height = $f.Height - 2
    $inner.BackColor = $CLR.white
    $f.Controls.Add($inner)

    $strip = New-Object System.Windows.Forms.Panel
    $strip.Left = 0; $strip.Top = 0; $strip.Width = $inner.Width; $strip.Height = 24
    $strip.BackColor = $CLR.softBlue
    $inner.Controls.Add($strip)

    $t = New-Object System.Windows.Forms.Label
    $t.Text = ''
    $t.ForeColor = $CLR.black
    $t.BackColor = $CLR.softBlue
    $t.Font = New-Object System.Drawing.Font('Microsoft YaHei', 9, [System.Drawing.FontStyle]::Bold)
    $t.Left = 8; $t.Top = 4; $t.Width = $inner.Width - 16; $t.Height = 18
    $strip.Controls.Add($t)

    $b = New-Object System.Windows.Forms.Label
    $b.Text = ''
    $b.ForeColor = $CLR.black
    $b.BackColor = $CLR.white
    $b.Font = New-Object System.Drawing.Font('Consolas', 8.5)
    $b.Left = 10; $b.Top = 30; $b.Width = $inner.Width - 20; $b.Height = 32
    $inner.Controls.Add($b)

    $s = New-Object System.Windows.Forms.Label
    $s.Text = ''
    $s.ForeColor = $CLR.blueText
    $s.BackColor = $CLR.white
    $s.Font = New-Object System.Drawing.Font('Microsoft YaHei', 8)
    $s.Left = 10; $s.Top = 64; $s.Width = $inner.Width - 20; $s.Height = 20
    $inner.Controls.Add($s)

    $total = $userList.Count + 1
    $btnW = [int]([Math]::Floor(($inner.Width - 20 - (($total - 1) * 6)) / $total))
    if ($btnW -lt 54) { $btnW = 54 }
    $x = 10
    foreach ($name in $userList) {
        $btn = New-Object System.Windows.Forms.Button
        $btn.Text = $name
        $btn.Tag = $name
        $btn.Left = $x; $btn.Top = 94; $btn.Width = $btnW; $btn.Height = 28
        $btn.FlatStyle = 'Flat'
        $btn.BackColor = $CLR.softBlue
        $btn.ForeColor = $CLR.black
        $btn.FlatAppearance.BorderColor = $CLR.borderBlue
        $btn.FlatAppearance.BorderSize = 1
        $btn.Font = New-Object System.Drawing.Font('Microsoft YaHei', 8.5)
        $btn.Add_Click({
                $script:pendingCommit = $true
                $script:dlgStatus.Text = [string]$ui.pending
                Add-CommandLine 'commit' $script:promptId ([string]$this.Tag)
                Write-Status
            })
        $inner.Controls.Add($btn)
        $script:dlgButtons[$name] = $btn
        $x += $btnW + 6
    }

    $ig = New-Object System.Windows.Forms.Button
    $ig.Text = [string]$ui.ignoreLabel
    $ig.Tag = 'ignore'
    $ig.Left = $x; $ig.Top = 94; $ig.Width = $btnW; $ig.Height = 28
    $ig.FlatStyle = 'Flat'
    $ig.BackColor = $CLR.softYellow
    $ig.ForeColor = $CLR.black
    $ig.FlatAppearance.BorderColor = $CLR.borderBlue
    $ig.FlatAppearance.BorderSize = 1
    $ig.Font = New-Object System.Drawing.Font('Microsoft YaHei', 8.5)
    $ig.Add_Click({
            Add-CommandLine 'dismiss' $script:promptId ''
            $script:lastCapture = [string]$ui.ignored
            Hide-Dialog
            Update-Chip $null
            Write-Status
        })
    $inner.Controls.Add($ig)

    $script:dlg = $f
    $script:dlgTitle = $t
    $script:dlgBody = $b
    $script:dlgStatus = $s
    $script:dlgStrip = $strip
    # title strip / body / blank area are draggable (buttons excluded to avoid mis-clicks)
    Enable-Drag @($f, $inner, $strip, $t, $b, $s)
}

function Show-PromptDialog($prompt) {
    if (-not $script:dlg) { return }
    $id = [string]$prompt.id
    $wc = 0
    if ($null -ne $prompt.wordCount) { $wc = [int]$prompt.wordCount }
    $words = @()
    if ($prompt.words) { $words = @($prompt.words) }
    $preview = ($words | Select-Object -First 8) -join '  '
    if ($words.Count -gt 8) { $preview = $preview + '  ' + ($ui.promptMore -f ($words.Count - 8)) }
    if (-not $preview) { $preview = [string]$ui.promptEmpty }

    $script:dlgTitleText = ($ui.promptTitle -f $wc)
    $script:dlgTitle.Text = $script:dlgTitleText
    $script:dlgTitle.ForeColor = $CLR.black
    if ($script:dlgStrip) { $script:dlgStrip.BackColor = $CLR.softBlue }
    $script:dlgBody.Text = $preview
    $script:dlgStatus.Text = ''
    foreach ($k in $script:dlgButtons.Keys) { $script:dlgButtons[$k].Visible = $true }
    $script:promptId = $id
    $script:promptShownAt = Get-Date
    $script:pendingCommit = $false
    $script:resultShownAt = $null
    $script:lastCapture = "prompt $id"

    Place-NearCursor $script:dlg
    $script:dlg.Show()
    $script:dlgVisible = $true
    Write-DebugLog ("DLG SHOW id=$id words=$($words.Count)")
    Write-Status
}

function Show-ResultInDialog($res) {
    if (-not $script:dlg) { return }
    $ok = $true
    if ($null -ne $res.ok) { $ok = [bool]$res.ok }
    if ($ok) {
        $script:dlgTitleText = [string]$ui.okTitle
        $script:dlgTitle.Text = $script:dlgTitleText
        if ($script:dlgStrip) { $script:dlgStrip.BackColor = $CLR.softYellow }   # success = yellow strip
        $script:dlgBody.Text = ([string]$res.message)
        $script:dlgStatus.Text = ($ui.okToday -f $script:todayCount)
    } else {
        $script:dlgTitleText = [string]$ui.failTitle
        $script:dlgTitle.Text = $script:dlgTitleText
        if ($script:dlgStrip) { $script:dlgStrip.BackColor = $CLR.softBlue }
        $script:dlgBody.Text = [string]$res.message
        $script:dlgStatus.Text = ''
    }
    $script:dlgTitle.ForeColor = $CLR.black
    foreach ($k in $script:dlgButtons.Keys) { $script:dlgButtons[$k].Visible = $false }
    $script:resultShownAt = Get-Date
    if (-not $script:dlgVisible) {
        Place-NearCursor $script:dlg
        $script:dlg.Show()
        $script:dlgVisible = $true
    }
    Write-DebugLog ("DLG RESULT ok=$ok msg=$($res.message)")
    Write-Status
}

function Hide-Dialog {
    if ($script:dlg) { $script:dlg.Hide() }
    $script:dlgVisible = $false
    $script:dlgTitleText = ''
    $script:promptShownAt = $null
    $script:resultShownAt = $null
    foreach ($k in $script:dlgButtons.Keys) { $script:dlgButtons[$k].Visible = $true }
}

function Update-Chip($res) {
    if (-not $script:chipToday) { return }
    $script:chipToday.Text = ($ui.today -f $script:todayCount)
    if ($res -and $res.message) { $script:chipMsg.Text = [string]$res.message }
    else { $script:chipMsg.Text = $script:lastCapture }
}

# ---------------------------------------------------------------- clipboard

function Get-ClipboardSnapshot {
    for ($i = 0; $i -lt 4; $i++) {
        try {
            $hasText = [System.Windows.Forms.Clipboard]::ContainsText()
            $hasImg = [System.Windows.Forms.Clipboard]::ContainsImage()
            if ($hasText) { return @{ kind = 'text'; text = [System.Windows.Forms.Clipboard]::GetText() } }
            if ($hasImg) { return @{ kind = 'image' } }
            return @{ kind = 'none' }
        } catch {
            Start-Sleep -Milliseconds 50
        }
    }
    return @{ kind = 'none' }
}

function Save-ClipboardImage {
    if (-not $imageDir) { return '' }
    try {
        if (-not (Test-Path -LiteralPath $imageDir)) { New-Item -ItemType Directory -Path $imageDir -Force | Out-Null }
        $img = [System.Windows.Forms.Clipboard]::GetImage()
        if (-not $img) { return '' }
        $path = Join-Path $imageDir ("clip-{0}.png" -f (Get-Date).ToString('yyyyMMdd-HHmmss-fff'))
        $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        return $path
    } catch { return '' }
}

# ---------------------------------------------------------------- main loop

if ($showChip) { Build-Chip }
if ($showDialog) { Build-Dialog }
Write-Status
Write-DebugLog ("START pid=$PID promptMode=$promptMode autoCommit=$autoCommit users=" + ($userList -join ',') + " poll=${clipPollMs}ms")

try {
    $hb = 0
    while ($true) {
        $now = Get-Date

        # ---- clipboard change detection via the OS sequence number
        $seq = [WvClip]::GetClipboardSequenceNumber()
        if ($seq -ne $script:lastSeq) {
            $script:lastSeq = $seq
            $snap = Get-ClipboardSnapshot

            if ($snap.kind -eq 'text') {
                $text = [string]$snap.text
                $script:clipLen = $text.Length
                $trimmed = $text.Trim()
                $letters = ([regex]::Matches($trimmed, '[A-Za-z]')).Count
                $isDup = ($text -eq $script:lastText) -and (((($now - $script:lastTextAt).TotalSeconds)) -lt 2)
                if ($isDup) {
                    Write-DebugLog 'SKIP debounce-duplicate'
                    $script:lastText = $text
                    $script:lastTextAt = $now
                }
                elseif ($trimmed.Length -lt $minLen) {
                    $script:lastCapture = ($ui.ignored -f $ui.emptyMsg); Write-DebugLog 'SKIP short'
                }
                elseif ($trimmed.Length -gt $maxLen) {
                    $script:lastCapture = ($ui.ignored -f $ui.longMsg); Write-DebugLog "SKIP long len=$($trimmed.Length)"
                }
                elseif ($letters -lt 1) {
                    $script:lastCapture = ($ui.ignored -f $ui.noWordMsg); Write-DebugLog 'SKIP no-latin'
                }
                else {
                    $script:lastText = $text
                    $script:lastTextAt = $now
                    if ($autoCommit) {
                        Add-QueueLine @{ ts = $now.ToString('s'); kind = 'text'; text = $text; via = 'clipboard'; user = $defaultUser }
                        $script:lastCapture = 'queued(auto)'
                    } else {
                        Add-QueueLine @{ ts = $now.ToString('s'); kind = 'text'; text = $text; via = 'clipboard' }
                        $script:lastCapture = 'queued, waiting for prompt'
                    }
                }
                Update-Chip $null
                Write-Status
            }
            elseif ($snap.kind -eq 'image') {
                $path = Save-ClipboardImage
                Add-QueueLine @{ ts = $now.ToString('s'); kind = 'image'; imagePath = $path; via = 'clipboard-image' }
                $script:lastCapture = 'image queued'
                Update-Chip $null
                Write-Status
            }
        }

        # ---- host-triggered capture (slash command / test)
        if ($triggerPath -and (Test-Path -LiteralPath $triggerPath)) {
            $who = ''
            try { $who = (Get-Content -LiteralPath $triggerPath -Raw -Encoding UTF8).Trim() } catch { }
            Remove-Item -LiteralPath $triggerPath -Force -ErrorAction SilentlyContinue
            $snap = Get-ClipboardSnapshot
            Write-DebugLog ("TRIGGER who=$who snap=$($snap.kind) len=$(([string]$snap.text).Length)")
            if ($snap.kind -eq 'text' -and ([string]$snap.text).Trim().Length -ge $minLen) {
                $script:lastText = [string]$snap.text
                $script:lastTextAt = Get-Date
                Add-QueueLine @{ ts = (Get-Date).ToString('s'); kind = 'text'; text = [string]$snap.text; via = 'trigger'; user = $who }
                $script:lastCapture = 'triggered'
                Write-Status
            }
        }

        # ---- picker prompt from host
        if ($showDialog -and $promptMode) {
            $pr = Get-Prompt
            if ($pr -and $pr.id) {
                $promptIdNow = [string]$pr.id
                if ($promptIdNow -ne $script:lastPromptSeen) {
                    $script:lastPromptSeen = $promptIdNow
                    if ($pr.wordCount -and [int]$pr.wordCount -gt 0) {
                        Show-PromptDialog $pr
                    } else {
                        Write-DebugLog "PROMPT empty id=$promptIdNow -> no dialog"
                        $script:lastCapture = 'no words, nothing to pick'
                        Add-CommandLine 'dismiss' $promptIdNow ''
                        Update-Chip $null
                        Write-Status
                    }
                }
            }
        }

        # ---- prompt timeout
        if ($script:dlgVisible -and $script:promptShownAt -and -not $script:pendingCommit -and $promptTimeoutMs -gt 0) {
            if (((($now - $script:promptShownAt).TotalMilliseconds)) -gt $promptTimeoutMs) {
                Write-DebugLog ("DLG TIMEOUT id=$($script:promptId)")
                Add-CommandLine 'dismiss' $script:promptId ''
                $script:lastCapture = [string]$ui.ignored
                Hide-Dialog
                Update-Chip $null
                Write-Status
            }
        }

        # ---- result from host: update the chip always, close the dialog for our own action
        $res = Get-HostResult
        if ($res -and $res.at) {
            $stamp = [string]$res.at + '|' + [string]$res.message
            if ($stamp -ne $script:lastResultStamp) {
                $script:lastResultStamp = $stamp
                if ($null -ne $res.todayCount) { $script:todayCount = [int]$res.todayCount }
                if ($script:pendingCommit) {
                    Show-ResultInDialog $res
                    $script:pendingCommit = $false
                }
                Update-Chip $res
                Write-Status
            }
        }

        # ---- auto-hide the dialog shortly after showing a result
        if ($script:dlgVisible -and $script:resultShownAt) {
            if (((($now - $script:resultShownAt).TotalMilliseconds)) -gt 2600) { Hide-Dialog; Write-Status }
        }

        $hb++
        if ($hb % 20 -eq 0) { Write-Status }
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds $clipPollMs
    }
}
finally {
    try { Write-TextFile $statusPath (([ordered]@{ ready = $false; pid = $PID; stoppedAt = (Get-Date).ToString('s') }) | ConvertTo-Json -Compress) } catch { }
}
