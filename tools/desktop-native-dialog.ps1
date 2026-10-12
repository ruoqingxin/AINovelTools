param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$Title,
    [ValidateSet("Inspect", "Cancel", "Select")][string]$Action = "Inspect",
    [string]$Path
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class NativeAcceptance {
    public delegate bool Callback(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, Callback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder text, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder text, int size);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr wParam, string lParam);
    [DllImport("user32.dll", EntryPoint = "SendMessageW")] public static extern IntPtr Click(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
    public static string Class(IntPtr handle) {
        var text = new StringBuilder(256);
        GetClassName(handle, text, text.Capacity);
        return text.ToString();
    }
    public static IntPtr Dialog(uint process, string title) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((handle, unused) => {
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            if (owner != process || Class(handle) != "#32770") return true;
            var text = new StringBuilder(1024);
            GetWindowText(handle, text, text.Capacity);
            if (text.ToString() != title) return true;
            found = handle;
            return false;
        }, IntPtr.Zero);
        return found;
    }
    public static IntPtr[] Children(IntPtr parent) {
        var children = new List<IntPtr>();
        EnumChildWindows(parent, (handle, unused) => { children.Add(handle); return true; }, IntPtr.Zero);
        return children.ToArray();
    }
}
'@

$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if ($Action -eq "Select") {
    $absolute = [IO.Path]::GetFullPath($Path)
    if (-not $absolute.StartsWith($workspace + "\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Acceptance selection must remain inside the workspace."
    }
}

# Native HWND/control IDs also work when UI Automation exposes only the shell
# list pane. Never search or send input to another process or dialog title.
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$dialog = [IntPtr]::Zero
$button = $null
do {
    $dialog = [NativeAcceptance]::Dialog($ProcessId, $Title)
    if ($dialog -ne [IntPtr]::Zero) {
        $children = [NativeAcceptance]::Children($dialog)
        $buttonId = if ($Action -eq "Cancel") { 2 } else { 1 }
        $button = $children | Where-Object {
            [NativeAcceptance]::Class($_) -eq "Button" -and
            [NativeAcceptance]::GetDlgCtrlID($_) -eq $buttonId -and
            [NativeAcceptance]::IsWindowEnabled($_)
        } | Select-Object -First 1
        if ($null -ne $button) { break }
    }
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)

if ($dialog -eq [IntPtr]::Zero) { throw "Native dialog not found for process $ProcessId." }
$summary = @($children | ForEach-Object {
    @{ id = [NativeAcceptance]::GetDlgCtrlID($_); class = [NativeAcceptance]::Class($_) }
})
if ($null -eq $button) {
    throw ("Native action button not found. Controls: " + ($summary | ConvertTo-Json -Compress))
}
if ($Action -eq "Select") {
    $edit = $children | Where-Object {
        [NativeAcceptance]::Class($_) -eq "Edit" -and
        [NativeAcceptance]::GetDlgCtrlID($_) -in @(1001, 1152)
    } | Select-Object -First 1
    if ($null -eq $edit) {
        throw ("Native path edit not found. Controls: " + ($summary | ConvertTo-Json -Compress))
    }
    if ([NativeAcceptance]::SendMessage($edit, 0x000C, [IntPtr]::Zero, $absolute) -eq [IntPtr]::Zero) {
        throw "Native path edit rejected WM_SETTEXT."
    }
}
if ($Action -ne "Inspect") {
    $null = [NativeAcceptance]::SetForegroundWindow($dialog)
    $null = [NativeAcceptance]::Click($button, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
}
@{ processId = $ProcessId; title = $Title; action = $Action; controls = $summary } | ConvertTo-Json -Depth 4 -Compress
