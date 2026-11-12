import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import type { ShellSpawnSpec } from "./shell-job-manager";

// A PID tree cannot recover descendants whose intermediate parents have exited.
// Windows 10+ assigns JOB_LIST at process creation, before any user code runs:
// https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812
// The supervisor alone owns the non-inheritable KILL_ON_JOB_CLOSE handle. It
// reaps the job on root exit, control-pipe EOF (including Main crash), or death.
// Keep this in the compiled module so packaged builds need no extra asset/tool.
const supervisor = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())) | ConvertFrom-Json
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class FireflyShellJob {
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public long UserTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
    public int Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedBytes, Input, Output, Error, Attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint Pid, Tid;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref Limits l, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr j, int c, IntPtr p, int size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr j, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr p, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr p, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr old, IntPtr length);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr p);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, string env, string cwd, ref Startup startup, out ProcessInfo info);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static IntPtr Inheritable(IntPtr h) {
    IntPtr copy;
    Check(DuplicateHandle(new IntPtr(-1), h, new IntPtr(-1), out copy, 0, true, 2));
    return copy;
  }
  public static int Run(string executable, string command, string cwd, string env) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero, jobList = IntPtr.Zero;
    IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
    IntPtr accounting = IntPtr.Zero;
    ProcessInfo process = new ProcessInfo();
    object gate = new object();
    bool stopped = false, initialized = false;
    try {
      Limits limits = new Limits();
      limits.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
      Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)));
      IntPtr nul = CreateFile("NUL", 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (nul == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
      try { input = Inheritable(nul); } finally { CloseHandle(nul); }
      output = Inheritable(GetStdHandle(-11));
      error = Inheritable(GetStdHandle(-12));
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
      attributes = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size));
      initialized = true;
      jobList = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(jobList, job);
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      // Only stdio is inherited: never leak the job or the control pipe.
      handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
      Marshal.WriteIntPtr(handles, 0, input);
      Marshal.WriteIntPtr(handles, IntPtr.Size, output);
      Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, error);
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      Startup startup = new Startup();
      startup.Size = Marshal.SizeOf(startup);
      startup.Flags = 0x100; // STARTF_USESTDHANDLES
      startup.Input = input; startup.Output = output; startup.Error = error;
      startup.Attributes = attributes;
      Thread control = new Thread(() => {
        try { while (Console.In.Read() >= 0) {} } catch (System.IO.IOException) {}
        lock (gate) { stopped = true; TerminateJobObject(job, 1); }
      });
      control.IsBackground = true;
      control.Start();
      lock (gate) {
        if (stopped) return 1;
        // JOB_LIST closes even the create-suspended/assign crash window.
        Check(CreateProcess(String.IsNullOrEmpty(executable) ? null : executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true,
          0x08080400, env, cwd, ref startup, out process)); // NO_WINDOW | EXTENDED_STARTUPINFO | UNICODE_ENVIRONMENT
      }
      if (WaitForSingleObject(process.Process, 0xFFFFFFFF) != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint exitCode;
      Check(GetExitCodeProcess(process.Process, out exitCode));
      Check(TerminateJobObject(job, 1));
      // Termination is asynchronous. Do not release Main's permit while any
      // detached descendant still executes, even with disconnected stdio.
      accounting = Marshal.AllocHGlobal(48);
      do {
        Check(QueryInformationJobObject(job, 1, accounting, 48, IntPtr.Zero));
        if (Marshal.ReadInt32(accounting, 40) == 0) break;
        Thread.Sleep(10);
      } while (true);
      return unchecked((int)exitCode);
    } finally {
      // Synchronize the EOF thread with handle closure (no reused-handle kill).
      lock (gate) { CloseHandle(job); job = IntPtr.Zero; }
      if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
      if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
      if (input != IntPtr.Zero) CloseHandle(input);
      if (output != IntPtr.Zero) CloseHandle(output);
      if (error != IntPtr.Zero) CloseHandle(error);
      if (initialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
      if (accounting != IntPtr.Zero) Marshal.FreeHGlobal(accounting);
    }
  }
}
'@
  exit [FireflyShellJob]::Run($payload.executable, $payload.command, $payload.cwd, $payload.env)
} catch {
  [IO.File]::WriteAllText($payload.errorFile, $_.Exception.Message)
  exit 1
}
`;

/** MSVCRT argument quoting, matching Node/libuv when verbatim is disabled. */
function quoteArgument(value: string): string {
  if (value && !/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

export function spawnWindowsShellJob(spec: ShellSpawnSpec, errorFile: string): ChildProcess {
  // CreateProcess truncates NUL; retain Node spawn's rejection of these inputs.
  if ([spec.command, ...spec.args].some((value) => value.includes("\0"))) {
    throw new TypeError("Shell command and arguments must not contain null bytes");
  }
  const child = spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(supervisor, "utf16le").toString("base64")],
    { cwd: spec.cwd || undefined, env: spec.env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const command = [quoteArgument(spec.command), ...spec.args.map((arg) => spec.windowsVerbatimArguments ? arg : quoteArgument(arg))].join(" ");
  // JSON is data on a private pipe, never interpolated into PowerShell/C# code.
  // Preserve the supplied environment rather than PowerShell's modified one.
  const seenKeys = new Set<string>();
  const env = Object.keys(spec.env).sort().filter((key) => {
    const normalized = key.toUpperCase();
    if (spec.env[key] === undefined || seenKeys.has(normalized)) return false;
    seenKeys.add(normalized);
    return true;
  })
    .map((key) => `${key}=${spec.env[key]}`).join("\0") + "\0\0";
  child.stdin!.on("error", () => { /* supervisor may fail/exit before reading */ });
  child.stdin!.write(Buffer.from(JSON.stringify({ executable: path.isAbsolute(spec.command) ? spec.command : null, command, cwd: spec.cwd || process.cwd(), env, errorFile })).toString("base64") + "\n");
  return child;
}
