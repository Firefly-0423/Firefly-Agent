param(
  [Parameter(Mandatory=$true)][string]$TargetFile,
  [Parameter(Mandatory=$true)][string]$LinkFile
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class FileSymlinkProbe {
  [DllImport("kernel32.dll", EntryPoint="CreateSymbolicLinkW", ExactSpelling=true,
    CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.I1)]
  private static extern bool CreateSymbolicLink(string link, string target, uint flags);
  public static int Create(string link, string target) {
    // Real file symlink; 2 matches libuv's ALLOW_UNPRIVILEGED_CREATE flag.
    return CreateSymbolicLink(link, target, 2) ? 0 : Marshal.GetLastWin32Error();
  }
}
'@
@{win32Code=[FileSymlinkProbe]::Create($LinkFile,$TargetFile)} | ConvertTo-Json -Compress
