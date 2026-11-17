# Activity helper for Windows (hud/server/activity.mjs starts it, hidden, and keeps it running).
#
# For every line it reads on standard input it writes one JSON line:
#   { name, desc, path, pid, idle, locked, fullscreen, minecraft, title }
# name = process name of the window in front, desc = its product description, idle = seconds since
# the last keyboard or mouse input. It reads no window contents and no keystrokes. The window title
# is used inside this script only to tell Minecraft from other Java programs; it is passed on only
# with -Titles and only for browsers and editors.
#
#   -Once     answer once and exit (used by the pulse)
#   -Titles   include window titles of browsers and editors
#
# This file is static: nothing from the user's data is ever pasted into it.
param([switch]$Once, [switch]$Titles)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$source = @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class JarvisActivity
{
    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();

    public static IntPtr Foreground() { return GetForegroundWindow(); }

    public static uint ProcessOf(IntPtr hWnd)
    {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        return pid;
    }

    // A Store app lives inside a frame window that belongs to another process: the real one owns a child window.
    public static uint ChildProcessOf(IntPtr hWnd, uint framePid)
    {
        uint found = 0;
        EnumChildWindows(hWnd, delegate(IntPtr child, IntPtr lParam)
        {
            uint pid;
            GetWindowThreadProcessId(child, out pid);
            if (pid != 0 && pid != framePid) { found = pid; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static uint IdleSeconds()
    {
        LASTINPUTINFO info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        if (!GetLastInputInfo(ref info)) return 0;
        return unchecked((uint)Environment.TickCount - info.dwTime) / 1000;
    }

    public static string Title(IntPtr hWnd)
    {
        StringBuilder text = new StringBuilder(512);
        GetWindowText(hWnd, text, text.Capacity);
        return text.ToString();
    }

    public static bool Fullscreen(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero || hWnd == GetShellWindow() || hWnd == GetDesktopWindow()) return false;
        RECT rect;
        if (!GetWindowRect(hWnd, out rect)) return false;
        MONITORINFO info = new MONITORINFO();
        info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        if (!GetMonitorInfo(MonitorFromWindow(hWnd, 2), ref info)) return false;
        return rect.Left <= info.rcMonitor.Left && rect.Top <= info.rcMonitor.Top && rect.Right >= info.rcMonitor.Right && rect.Bottom >= info.rcMonitor.Bottom;
    }

    // While the workstation is locked the input desktop is not ours and cannot be opened.
    public static bool InputDesktopOpen()
    {
        IntPtr desktop = OpenInputDesktop(0, false, 0x0100);
        if (desktop == IntPtr.Zero) return false;
        CloseDesktop(desktop);
        return true;
    }
}
"@

try {
    Add-Type -TypeDefinition $source -Language CSharp
} catch {
    [Console]::Out.WriteLine('{"error":"compile"}')
    exit 1
}

$titleApps = @('chrome', 'msedge', 'firefox', 'brave', 'opera', 'opera_gx', 'vivaldi', 'arc', 'zen', 'Code', 'Cursor', 'Windsurf', 'devenv', 'idea64', 'pycharm64', 'webstorm64', 'rider64', 'clion64', 'phpstorm64', 'sublime_text', 'notepad++', 'zed')
$shellApps = @('explorer', 'SearchHost', 'StartMenuExperienceHost', 'ShellExperienceHost')

function Get-Sample {
    # A scheduled task without a logged-in desktop sees no windows at all: say so instead of guessing.
    if (-not [Environment]::UserInteractive -or [System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
        return '{"error":"noninteractive"}'
    }
    $out = [ordered]@{ name = $null; desc = $null; path = $null; pid = 0; idle = [int][JarvisActivity]::IdleSeconds(); locked = $false; fullscreen = $false; minecraft = $false; title = $null }
    $window = [JarvisActivity]::Foreground()
    $processId = 0
    if ($window -ne [IntPtr]::Zero) { $processId = [int][JarvisActivity]::ProcessOf($window) }
    $process = $null
    if ($processId -gt 0) {
        try { $process = [System.Diagnostics.Process]::GetProcessById($processId) } catch { $process = $null }
    }
    if ($process -and $process.ProcessName -eq 'ApplicationFrameHost') {
        $inner = [int][JarvisActivity]::ChildProcessOf($window, [uint32]$processId)
        if ($inner -gt 0) {
            try { $process = [System.Diagnostics.Process]::GetProcessById($inner); $processId = $inner } catch { }
        }
    }
    if ($process) {
        $out.name = $process.ProcessName
        $out.pid = $processId
        try {
            $module = $process.MainModule
            $out.path = $module.FileName
            $description = $module.FileVersionInfo.FileDescription
            if ($description) { $out.desc = $description.Trim() }
        } catch {
            # a process of another user or a protected one: its name is enough
        }
    }
    $locked = (-not [JarvisActivity]::InputDesktopOpen()) -or ($out.name -eq 'LockApp') -or ($out.name -eq 'LogonUI')
    if (-not $locked -and $window -eq [IntPtr]::Zero) {
        # nothing in front for a moment (switching windows) is not a lock; a running lock screen is
        $locked = @(Get-Process -Name 'LogonUI' -ErrorAction SilentlyContinue).Count -gt 0
    }
    $out.locked = [bool]$locked
    if (-not $locked -and $window -ne [IntPtr]::Zero) {
        if ($shellApps -notcontains $out.name) { $out.fullscreen = [bool][JarvisActivity]::Fullscreen($window) }
        $title = [JarvisActivity]::Title($window)
        if ($out.name -eq 'javaw' -or $out.name -eq 'java') { $out.minecraft = [bool]($title -match '^(Minecraft|Lunar Client|Badlion)') }
        if ($Titles -and ($titleApps -contains $out.name) -and $title) {
            if ($title.Length -gt 200) { $title = $title.Substring(0, 200) }
            $out.title = $title
        }
    }
    return ($out | ConvertTo-Json -Compress)
}

function Write-Sample {
    try {
        [Console]::Out.WriteLine((Get-Sample))
    } catch {
        [Console]::Out.WriteLine('{"error":"sample"}')
    }
    [Console]::Out.Flush()
}

if ($Once) {
    Write-Sample
    exit 0
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line -or $line -eq 'q') { break }
    Write-Sample
}
