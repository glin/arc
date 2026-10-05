param([Parameter(Mandatory=$true)][string]$Attempt, [Parameter(Mandatory=$true)][string]$Node, [Parameter(Mandatory=$true)][string]$Worker, [Parameter(Mandatory=$true)][int]$OwnerPid, [Parameter(Mandatory=$true)][string]$OwnerStarted)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class ArcAttemptJob {
    public static void WatchOwner(int pid, string started) {
        var owner = System.Diagnostics.Process.GetProcessById(pid);
        if (owner.StartTime.ToUniversalTime().Ticks.ToString() != started)
            throw new InvalidOperationException("Runner identity changed");
        var handle = owner.Handle;
        var monitor = new System.Threading.Thread(() => {
            try { owner.WaitForExit(); } finally { Environment.Exit(1); }
        });
        monitor.IsBackground = true;
        monitor.Start();
    }
    [StructLayout(LayoutKind.Sequential)] public struct Basic {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr Minimum, Maximum; public uint Active;
        public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Io {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Extended {
        public Basic Limits; public Io Counters;
        public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    public static IntPtr Join(IntPtr process) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        Extended limits = new Extended(); limits.Limits.Flags = 0x2000;
        int size = Marshal.SizeOf(limits); IntPtr data = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(limits, data, false);
            if (!SetInformationJobObject(job, 9, data, (uint)size) || !AssignProcessToJobObject(job, process))
                throw new System.ComponentModel.Win32Exception();
        } finally { Marshal.FreeHGlobal(data); }
        return job;
    }
}
'@
$hostProcess = [System.Diagnostics.Process]::GetCurrentProcess()
$jobHandle = [ArcAttemptJob]::Join($hostProcess.Handle)
[ArcAttemptJob]::WatchOwner($OwnerPid, $OwnerStarted)
$ready = @{ pid = $PID; started = $hostProcess.StartTime.ToUniversalTime().Ticks.ToString(); job = 'kill-on-close' } | ConvertTo-Json
$readyTemp = Join-Path $Attempt 'host-ready.tmp'
[IO.File]::WriteAllText($readyTemp, $ready, (New-Object Text.UTF8Encoding($false)))
[IO.File]::Move($readyTemp, (Join-Path $Attempt 'host-ready.json'))
$authorization = Join-Path $Attempt 'authorize.json'
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while (!(Test-Path -LiteralPath $authorization)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Launch authorization deadline' }
    Start-Sleep -Milliseconds 100
}
$approved = Get-Content -Raw -LiteralPath $authorization | ConvertFrom-Json
if ($approved.host.pid -ne $PID -or $approved.host.started -ne $hostProcess.StartTime.ToUniversalTime().Ticks.ToString()) { throw 'Launch authorization identity mismatch' }
& $Node $Worker $Attempt
exit $LASTEXITCODE
