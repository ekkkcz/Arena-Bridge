# Create Desktop + Start Menu shortcuts pointing at the native launcher exe.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 using the
# ANSI codepage (gb2312 on this machine), so UTF-8 Chinese comments here would
# be mangled into a parse error.
$ErrorActionPreference = "Stop"
# Derive the repo root from this script's own location so it works on any
# machine and user account. Never hard-code an absolute path here.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $root "desktop\launcher\Arena Bridge.exe"
$ico  = Join-Path $root "app.ico"

# Must match app.setAppUserModelId() in desktop/app/main.cjs.
# Without it Windows groups the window under electron.exe in the taskbar and
# shows Electron's own icon; "pin to taskbar" would also pin the wrong entry.
$appId = "ekkkcz.ArenaBridge"

$targets = @(
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "Arena Bridge.lnk"),
  (Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs\Arena Bridge.lnk")
)

$cs = @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class LnkAppId {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLink { }
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }
    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        void GetCount(out uint cProps);
        void GetAt(uint iProp, out PROPERTYKEY pkey);
        void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        void Commit();
    }
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PROPERTYKEY { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Explicit)]
    public struct PROPVARIANT {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pointerValue;
    }
    public static void Create(string lnkPath, string target, string workdir, string icon, string appId) {
        var link = (IShellLinkW)new ShellLink();
        link.SetPath(target);
        link.SetWorkingDirectory(workdir);
        link.SetDescription("Arena Bridge");
        if (!string.IsNullOrEmpty(icon)) link.SetIconLocation(icon, 0);
        var pf = (IPersistFile)link;
        var store = (IPropertyStore)link;
        var key = new PROPERTYKEY();
        key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
        key.pid = 5;
        var pv = new PROPVARIANT();
        pv.vt = 31;
        pv.pointerValue = Marshal.StringToCoTaskMemUni(appId);
        try {
            store.SetValue(ref key, ref pv);
            store.Commit();
        } finally {
            Marshal.FreeCoTaskMem(pv.pointerValue);
        }
        pf.Save(lnkPath, true);
        Marshal.ReleaseComObject(link);
    }
}
'@
Add-Type -TypeDefinition $cs -ErrorAction Stop

foreach ($lnk in $targets) {
  $dir = Split-Path $lnk -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

  # The property store can only be written on a fresh file; an existing .lnk
  # that Explorer has cached returns STG_E_ACCESSDENIED.
  if (Test-Path $lnk) { Remove-Item $lnk -Force }

  [LnkAppId]::Create($lnk, $exe, $root, $ico, $appId)
  Write-Output ("created: " + $lnk + "  (appId=" + $appId + ")")
}
