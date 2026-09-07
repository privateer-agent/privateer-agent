<#
PrivateerComputer.ps1 — the Windows screen-control helper.

One long-lived process, spoken to in newline-delimited JSON on stdin/stdout. The client
is src/computer/helper.ts; the coordinate contract is src/computer/space.ts. Read that
file before changing anything here — the two halves must agree exactly or every click
lands wrong in a way nothing reports.

── Why PowerShell and not a compiled .exe ───────────────────────────────────

Windows PowerShell 5.1 ships with every supported version of Windows, and `Add-Type`
compiles the P/Invoke surface below at startup. So this is a real Win32 helper with no
build step, no toolchain, no native npm module, and nothing to sign separately from the
app. The cost is ~300ms of one-time JIT on first launch, which the long-lived process
pays once rather than per action.

── DPI IS THE WHOLE BALLGAME ON WINDOWS ─────────────────────────────────────

A process that has not declared DPI awareness is LIED TO by the operating system.
GetMonitorInfo returns virtualised 96-DPI coordinates, and CopyFromScreen returns a
stretched, blurry image of a smaller desktop. On a 150% display that is a 1.5x error in
every direction — and nothing reports it, because from inside the process the numbers
are self-consistent. So awareness is declared FIRST, before any screen call, and with a
three-step fallback because the good API is recent:

  SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)  Win10 1703+   — per-monitor, correct
  SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE) Win8.1+      — per-monitor
  SetProcessDPIAware()                                  Vista+       — system-wide only

Once per-monitor-aware, every rectangle Windows hands us is in PHYSICAL PIXELS, which is
exactly the space the agent's display-local device pixels live in. `scale` is then
reported for information only (the agent never converts through it on Windows).

── UIPI, and what "input: true" does not promise ────────────────────────────

Windows has no consent gate for screen capture or synthetic input, so both grants are
reported true. But User Interface Privilege Isolation silently DISCARDS input sent from a
normal-integrity process to an elevated window — so a UAC prompt, or an app launched as
administrator, cannot be driven from here and the events vanish with no error. There is
no reliable way to detect that before the fact (querying the foreground process's token
usually fails with access denied, which is itself ambiguous), so it is not reported as a
grant. It is documented in the tool description instead, which is the honest place for a
limitation we cannot measure.
#>

param(
    [switch]$Serve,
    [switch]$Grants,
    [switch]$Prompt,
    [switch]$Version
)

$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class PComp {
    // ── DPI ──────────────────────────────────────────────────────────────
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmon, int dpiType, out uint dpiX, out uint dpiY);

    public static void DeclareDpiAwareness() {
        // -4 is DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2. Each call throws
        // EntryPointNotFoundException on an OS too old to have it, so they are tried in
        // order of preference — see the header on why being wrong here is invisible.
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); return; } catch {}
        try { SetProcessDpiAwareness(2); return; } catch {}
        try { SetProcessDPIAware(); } catch {}
    }

    // ── Monitors ─────────────────────────────────────────────────────────
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFOEX {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);
    [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    public class Mon {
        public string Id; public string Label; public int X, Y, W, H; public double Scale; public bool Primary;
    }

    public static List<Mon> Monitors() {
        var found = new List<Mon>();
        MonitorEnumProc cb = delegate(IntPtr h, IntPtr hdc, ref RECT r, IntPtr d) {
            var info = new MONITORINFOEX();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (!GetMonitorInfo(h, ref info)) return true;
            double scale = 1.0;
            try {
                uint dx, dy;
                // 0 = MDT_EFFECTIVE_DPI. 96 is the unscaled baseline.
                if (GetDpiForMonitor(h, 0, out dx, out dy) == 0 && dx > 0) scale = dx / 96.0;
            } catch {}
            found.Add(new Mon {
                Id = info.szDevice,
                Label = info.szDevice,
                X = info.rcMonitor.Left,
                Y = info.rcMonitor.Top,
                W = info.rcMonitor.Right - info.rcMonitor.Left,
                H = info.rcMonitor.Bottom - info.rcMonitor.Top,
                Scale = scale,
                // MONITORINFOF_PRIMARY
                Primary = (info.dwFlags & 1) != 0
            });
            return true;
        };
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
        return found;
    }

    public static int ForegroundPid() {
        try { uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return (int)pid; }
        catch { return 0; }
    }

    // ── Capture ──────────────────────────────────────────────────────────
    //
    // Two steps in one call: grab the monitor's physical pixels, then resize to EXACTLY
    // the requested size. Exactly, because the agent's coordinate space is defined by
    // that size — a resize that rounded, or that returned the native frame, would put
    // agent space and the picture into disagreement and every click would be off by the
    // reduction factor.
    //
    // HighQualityBicubic for the same reason macOS uses high interpolation: a screenshot
    // is nearly always being REDUCED, and point-sampling text does not look soft, it
    // aliases — strokes break up and the model misreads them.
    static byte[] Encode(Bitmap source, int w, int h) {
        using (var scaled = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
            using (var g = Graphics.FromImage(scaled)) {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(source, new Rectangle(0, 0, w, h));
            }
            using (var ms = new MemoryStream()) {
                // PNG, not JPEG: UI is flat colour and hard edges, and JPEG ringing on
                // small text is exactly the detail being read.
                scaled.Save(ms, ImageFormat.Png);
                return ms.ToArray();
            }
        }
    }

    /// Returns { model-sized frame, dialog-sized preview }; the preview is null when it
    /// was not asked for. ONE CopyFromScreen feeding both, deliberately — grabbing twice
    /// would be two moments in time, so a person could approve a click against a screen
    /// the model never saw.
    public static byte[][] Capture(int x, int y, int w, int h, int tw, int th, int pw, int ph) {
        using (var shot = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
            using (var g = Graphics.FromImage(shot)) {
                g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
            }
            var main = Encode(shot, tw, th);
            byte[] preview = null;
            if (pw > 0 && ph > 0) {
                // Best-effort: the model's frame is already in hand, and a dialog that
                // falls back to text is far better than a failed capture.
                try { preview = Encode(shot, pw, ph); } catch {}
            }
            return new byte[][] { main, preview };
        }
    }

    // ── Input ────────────────────────────────────────────────────────────
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int cbSize);

    const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
    const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

    static void Send(INPUT[] inputs) {
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    /// Absolute mouse coordinates are NORMALISED to 0..65535 across the whole virtual
    /// desktop, not given in pixels — the single most common way Windows mouse
    /// automation ends up clicking the wrong place. VIRTUALDESK makes the normalisation
    /// span every monitor rather than only the primary, which is what makes a second
    /// display reachable at all.
    static INPUT MouseAt(int gx, int gy, uint extraFlags, uint mouseData) {
        int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);
        int vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
        if (vw < 2) vw = 2;
        if (vh < 2) vh = 2;
        var i = new INPUT();
        i.type = 0; // INPUT_MOUSE
        i.u.mi.dx = (int)Math.Round((gx - vx) * 65535.0 / (vw - 1));
        i.u.mi.dy = (int)Math.Round((gy - vy) * 65535.0 / (vh - 1));
        i.u.mi.mouseData = mouseData;
        i.u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | extraFlags;
        return i;
    }

    static void ButtonCodes(string button, out uint down, out uint up) {
        if (button == "right") { down = 0x0008; up = 0x0010; }
        else if (button == "middle") { down = 0x0020; up = 0x0040; }
        else { down = 0x0002; up = 0x0004; }
    }

    public static void Move(int gx, int gy) { Send(new INPUT[] { MouseAt(gx, gy, 0, 0) }); }

    public static void Click(int gx, int gy, string button, int clicks) {
        uint down, up;
        ButtonCodes(button, out down, out up);
        // The pointer moves first and as its own event: applications track hover from
        // the move, and a click arriving where the pointer has never been is missed by
        // menus and anything with a hover-to-open affordance.
        Send(new INPUT[] { MouseAt(gx, gy, 0, 0) });
        for (int n = 0; n < Math.Max(1, clicks); n++) {
            Send(new INPUT[] { MouseAt(gx, gy, down, 0), MouseAt(gx, gy, up, 0) });
            // Windows decides double-click by TIMING, not by a click count, so the pairs
            // must arrive inside the system double-click interval — hence no sleep here.
        }
    }

    public static void Drag(int gx, int gy, int tx, int ty, string button) {
        uint down, up;
        ButtonCodes(button, out down, out up);
        Send(new INPUT[] { MouseAt(gx, gy, 0, 0), MouseAt(gx, gy, down, 0) });
        // Interpolated, for the same reason as macOS: a drag delivered as down-then-up
        // at the destination is ignored by anything that starts its gesture on the first
        // move — most drag-and-drop, sliders, and every text selection.
        const int steps = 12;
        for (int i = 1; i <= steps; i++) {
            double t = (double)i / steps;
            Send(new INPUT[] { MouseAt((int)Math.Round(gx + (tx - gx) * t), (int)Math.Round(gy + (ty - gy) * t), 0, 0) });
            System.Threading.Thread.Sleep(8);
        }
        Send(new INPUT[] { MouseAt(tx, ty, up, 0) });
    }

    public static void Scroll(int gx, int gy, int dx, int dy) {
        Send(new INPUT[] { MouseAt(gx, gy, 0, 0) });
        // WHEEL_DELTA is 120 per notch. Windows scrolls DOWN on a negative delta and the
        // tool's contract is that negative scrolls UP, so the sign flips exactly once.
        if (dy != 0) Send(new INPUT[] { MouseAt(gx, gy, MOUSEEVENTF_WHEEL, unchecked((uint)(-dy * 120))) });
        if (dx != 0) Send(new INPUT[] { MouseAt(gx, gy, MOUSEEVENTF_HWHEEL, unchecked((uint)(dx * 120))) });
    }

    static INPUT Key(ushort vk, ushort scan, uint flags) {
        var i = new INPUT();
        i.type = 1; // INPUT_KEYBOARD
        i.u.ki.wVk = vk;
        i.u.ki.wScan = scan;
        i.u.ki.dwFlags = flags;
        return i;
    }

    /// Type literal text as UNICODE scan codes (wVk = 0), the exact counterpart of
    /// macOS's keyboardSetUnicodeString: it delivers the characters themselves, so it is
    /// correct on every keyboard layout and handles accents, CJK and emoji, none of which
    /// have a virtual-key code to look up. Surrogate pairs work because the string is
    /// walked as UTF-16 code units and each is sent in turn.
    public static void TypeText(string text) {
        foreach (char c in text) {
            Send(new INPUT[] {
                Key(0, c, KEYEVENTF_UNICODE),
                Key(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)
            });
            // Applications with their own input handling (Electron, Java, terminals)
            // drop events delivered faster than a person could type.
            System.Threading.Thread.Sleep(6);
        }
    }

    public static void PressKeys(ushort[] modifiers, ushort vk) {
        var down = new List<INPUT>();
        foreach (var m in modifiers) down.Add(Key(m, 0, 0));
        down.Add(Key(vk, 0, 0));
        Send(down.ToArray());
        var up = new List<INPUT>();
        up.Add(Key(vk, 0, KEYEVENTF_KEYUP));
        // Modifiers release in REVERSE order, the way a hand leaves a chord. Releasing
        // ctrl before the key it modified leaves applications seeing a bare keypress.
        for (int i = modifiers.Length - 1; i >= 0; i--) up.Add(Key(modifiers[i], 0, KEYEVENTF_KEYUP));
        Send(up.ToArray());
    }
}
'@

# BEFORE any screen call. See the header — getting this wrong is invisible from inside.
[PComp]::DeclareDpiAwareness()

# ── Named keys ───────────────────────────────────────────────────────────────
# Only keys whose position is fixed. Letters and digits are here for CHORDS only
# (ctrl+s), where every application's shortcut table is written against the US
# position; literal characters go through TypeText, which is layout-independent.
$VK = @{
    'return' = 0x0D; 'enter' = 0x0D; 'tab' = 0x09; 'space' = 0x20
    'backspace' = 0x08; 'delete' = 0x2E; 'forwarddelete' = 0x2E
    'escape' = 0x1B; 'esc' = 0x1B
    'left' = 0x25; 'up' = 0x26; 'right' = 0x27; 'down' = 0x28
    'home' = 0x24; 'end' = 0x23; 'pageup' = 0x21; 'pagedown' = 0x22
    'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73; 'f5' = 0x74; 'f6' = 0x75
    'f7' = 0x76; 'f8' = 0x77; 'f9' = 0x78; 'f10' = 0x79; 'f11' = 0x7A; 'f12' = 0x7B
}
$MODS = @{
    'ctrl' = 0x11; 'control' = 0x11
    'alt' = 0x12; 'option' = 0x12; 'opt' = 0x12
    'shift' = 0x10
    # cmd/meta/super map to the Windows key. Accepted so a model that learned "cmd+s"
    # on macOS does not silently send nothing here — though on Windows the useful
    # shortcut is almost always ctrl, which the tool description says.
    'cmd' = 0x5B; 'command' = 0x5B; 'meta' = 0x5B; 'super' = 0x5B; 'win' = 0x5B
}

function Get-Monitors {
    $out = @()
    foreach ($m in [PComp]::Monitors()) {
        $out += [ordered]@{
            id = $m.Id; label = $m.Label
            width = $m.W; height = $m.H
            scale = $m.Scale
            # Reported in the SAME physical pixels as width/height, because a
            # per-monitor-aware process is given physical pixels throughout. Still
            # informational only — the agent never converts through it.
            originX = $m.X; originY = $m.Y
            primary = $m.Primary
        }
    }
    return $out
}

function Get-Grants {
    # Windows gates neither screen capture nor synthetic input, so both are true. UIPI
    # can still swallow input aimed at an elevated window and cannot be detected
    # reliably — see the header; it is documented, not reported as a grant.
    return [ordered]@{
        screen = $true
        input = $true
        secureInput = $false
        frontmostPid = [PComp]::ForegroundPid()
    }
}

function Write-Frame($obj) {
    # -Compress keeps it to ONE line (the client reads newline-delimited frames) and
    # -Depth 10 is required because ConvertTo-Json truncates at depth 2 by default,
    # which would silently empty the displays array.
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Depth 10 -Compress))
    [Console]::Out.Flush()
}

function Send-Ok($id, $fields) {
    $out = [ordered]@{ id = $id; ok = $true }
    if ($fields) { foreach ($k in $fields.Keys) { $out[$k] = $fields[$k] } }
    Write-Frame $out
}

function Send-Fail($id, $message) {
    Write-Frame ([ordered]@{ id = $id; ok = $false; error = $message })
}

if ($Version) { Write-Output 'privateer-computer 1'; exit 0 }

if ($Grants) {
    Write-Frame ([ordered]@{ ok = $true; grants = (Get-Grants); displays = (Get-Monitors) })
    exit 0
}

if (-not $Serve) {
    [Console]::Error.WriteLine('usage: PrivateerComputer.ps1 -Serve | -Grants | -Version')
    exit 2
}

function Find-Monitor($id) {
    $all = [PComp]::Monitors()
    if ($null -eq $id -or $id -eq '') {
        $p = $all | Where-Object { $_.Primary } | Select-Object -First 1
        if ($p) { return $p }
        return ($all | Select-Object -First 1)
    }
    return ($all | Where-Object { $_.Id -eq $id } | Select-Object -First 1)
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
    $line = $line.Trim()
    if ($line -eq '') { continue }

    $req = $null
    try { $req = $line | ConvertFrom-Json } catch { Send-Fail $null 'malformed request'; continue }
    $id = $req.id
    $op = [string]$req.op

    try {
        switch ($op) {
            'displays' { Send-Ok $id @{ displays = (Get-Monitors) } }

            'grants' { Send-Ok $id @{ grants = (Get-Grants) } }

            'capture' {
                $m = Find-Monitor $req.display
                if (-not $m) { Send-Fail $id 'no such display'; continue }
                $tw = if ($req.targetWidth) { [int]$req.targetWidth } else { $m.W }
                $th = if ($req.targetHeight) { [int]$req.targetHeight } else { $m.H }
                $pw = if ($req.previewWidth) { [int]$req.previewWidth } else { 0 }
                $ph = if ($req.previewHeight) { [int]$req.previewHeight } else { 0 }
                $shots = [PComp]::Capture($m.X, $m.Y, $m.W, $m.H, $tw, $th, $pw, $ph)
                $fields = [ordered]@{
                    mimeType = 'image/png'
                    data = [Convert]::ToBase64String($shots[0])
                    width = $tw
                    height = $th
                }
                if ($shots[1]) { $fields['preview'] = [Convert]::ToBase64String($shots[1]) }
                Send-Ok $id $fields
            }

            'pointer' {
                $m = Find-Monitor $req.display
                if (-not $m) { Send-Fail $id 'no such display'; continue }
                # Display-local physical pixels → global physical pixels. The ONLY
                # conversion, mirroring the macOS helper's globalPoint.
                $gx = $m.X + [int]$req.x
                $gy = $m.Y + [int]$req.y
                $button = if ($req.button) { [string]$req.button } else { 'left' }
                switch ([string]$req.action) {
                    'move' { [PComp]::Move($gx, $gy) }
                    'click' { [PComp]::Click($gx, $gy, $button, 1) }
                    'double_click' { [PComp]::Click($gx, $gy, $button, 2) }
                    'drag' {
                        $tx = $m.X + [int]$req.toX
                        $ty = $m.Y + [int]$req.toY
                        [PComp]::Drag($gx, $gy, $tx, $ty, $button)
                    }
                    'scroll' {
                        $dx = if ($req.scrollX) { [int]$req.scrollX } else { 0 }
                        $dy = if ($req.scrollY) { [int]$req.scrollY } else { 0 }
                        [PComp]::Scroll($gx, $gy, $dx, $dy)
                    }
                    default { Send-Fail $id ("unknown pointer action `"" + $req.action + "`""); continue }
                }
                Send-Ok $id $null
            }

            'key' {
                switch ([string]$req.action) {
                    'type' { [PComp]::TypeText([string]$req.text); Send-Ok $id $null }
                    'press' {
                        $spec = ([string]$req.keys).ToLower().Trim()
                        if ($spec -eq '') { Send-Fail $id 'empty key combination'; continue }
                        $parts = $spec.Split('+')
                        $last = $parts[-1]
                        $mods = @()
                        $bad = $null
                        for ($i = 0; $i -lt $parts.Length - 1; $i++) {
                            $p = $parts[$i]
                            if ($MODS.ContainsKey($p)) { $mods += [uint16]$MODS[$p] }
                            else { $bad = $p; break }
                        }
                        if ($bad) { Send-Fail $id ("unknown modifier `"" + $bad + "`" in `"" + $spec + "`""); continue }
                        $vk = $null
                        if ($VK.ContainsKey($last)) { $vk = $VK[$last] }
                        elseif ($last.Length -eq 1 -and $last -match '[a-z0-9]') {
                            $vk = [int][char]([string]$last).ToUpper()
                        }
                        if ($null -eq $vk) { Send-Fail $id ("unknown key `"" + $last + "`" in `"" + $spec + "`""); continue }
                        [PComp]::PressKeys([uint16[]]$mods, [uint16]$vk)
                        Send-Ok $id $null
                    }
                    default { Send-Fail $id 'unknown key action' }
                }
            }

            default { Send-Fail $id ("unknown op `"" + $op + "`"") }
        }
    } catch {
        # A helper that dies on one bad frame takes the whole session's screen control
        # with it. Report and keep serving.
        Send-Fail $id $_.Exception.Message
    }
}
