// Windows Framework supplies the compiler and runtime for the local channel bridge.
export const WINDOW_PIPE_SOURCE = String.raw`
using System;
using System.IO;
using System.Diagnostics;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

class ArcPipe {
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProcessEntry { public uint size, usage, pid; public IntPtr heap; public uint module, threads, parent; public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateNamedPipe(string name, uint access, uint mode, uint instances, uint output, uint input, uint timeout, ref SecurityAttributes attributes);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ConnectNamedPipe(IntPtr pipe, IntPtr overlapped);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeServerProcessId(SafeFileHandle pipe, out uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CancelIoEx(SafeFileHandle pipe, IntPtr overlapped);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool WaitNamedPipe(string name, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr pipe, IntPtr bytes, int length, out int count, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr pipe, IntPtr bytes, int length, out int count, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetOverlappedResult(IntPtr pipe, IntPtr overlapped, out int count, bool wait);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateEvent(IntPtr security, bool manual, bool initial, IntPtr name);
  [StructLayout(LayoutKind.Sequential)] struct Overlapped { public IntPtr status, count; public uint offset, high; public IntPtr eventHandle; }
  static bool Io(Connection stream, byte[] bytes, bool write, out int count) {
    IntPtr signal = CreateEvent(IntPtr.Zero, true, false, IntPtr.Zero);
    IntPtr overlapped = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Overlapped)));
    var pinned = GCHandle.Alloc(bytes ?? new byte[1], GCHandleType.Pinned);
    bool retained = false;
    SafeFileHandle handle = stream.handle;
    try {
      if(signal == IntPtr.Zero) throw new IOException("Connection unavailable");
      Marshal.StructureToPtr(new Overlapped { eventHandle = signal }, overlapped, false);
      bool done; int error; IntPtr native;
      count = 0;
      // Issue and cancellation share a lock so close cannot cancel before an operation starts.
      lock(stream) {
        if(stream.closed) return false;
        handle.DangerousAddRef(ref retained);
        native = handle.DangerousGetHandle();
        if(bytes == null) done = ConnectNamedPipe(native, overlapped);
        else if(write) done = WriteFile(native, pinned.AddrOfPinnedObject(), bytes.Length, out count, overlapped);
        else done = ReadFile(native, pinned.AddrOfPinnedObject(), bytes.Length, out count, overlapped);
        error = Marshal.GetLastWin32Error();
      }
      if(bytes == null && error == 535) return true;
      // Cancellation only requests completion. The raw handle stays retained until that completion arrives.
      return done || (error == 997 && GetOverlappedResult(native, overlapped, out count, true));
    } finally { pinned.Free(); Marshal.FreeHGlobal(overlapped); CloseHandle(signal); if(retained) handle.DangerousRelease(); }
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint GetNamedSecurityInfo(string name, uint kind, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle handle, uint kind, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  static readonly object outputLock = new object(), stateLock = new object();
  class Connection {
    public SafeFileHandle handle;
    public Queue<byte[]> writes = new Queue<byte[]>();
    public int pending;
    public bool writing;
    public bool closed;
    public void Close() { lock(this) { if(closed) return; closed = true; if(handle != null) { CancelIoEx(handle, IntPtr.Zero); handle.Dispose(); } Monitor.PulseAll(this); } }
    public void Write(byte[] bytes) {
      lock(this) {
        if(closed) return;
        if(pending + bytes.Length > 65536) { Close(); return; }
        pending += bytes.Length; writes.Enqueue(bytes);
        if(writing) return;
        writing = true;
      }
      ThreadPool.QueueUserWorkItem(delegate {
        try { while(true) { byte[] next;
          lock(this) { if(writes.Count == 0) { writing = false; return; } next = writes.Dequeue(); }
          int count;
          if(!Io(this, next, true, out count) || count != next.Length) { Close(); return; }
          lock(this) pending -= next.Length;
        } } catch(Exception) { Close(); }
      });
    }
  }
  static readonly Dictionary<int, Connection> streams = new Dictionary<int, Connection>();
  static readonly Dictionary<int, Connection> listeners = new Dictionary<int, Connection>();
  static readonly Dictionary<int, Connection> connecting = new Dictionary<int, Connection>();
  static readonly HashSet<int> servers = new HashSet<int>();
  static readonly Dictionary<int, int> active = new Dictionary<int, int>();
  static int nextSocket = 1000000;
  static void Output(string text) { lock(outputLock) { Console.WriteLine(text); Console.Out.Flush(); } }
  static string Decode(string text) { return Encoding.UTF8.GetString(Convert.FromBase64String(text)); }
  static string Owner(uint pid) {
    IntPtr process = OpenProcess(0x1000, false, pid), token;
    if(process == IntPtr.Zero) throw new IOException("Process unavailable");
    try { if(!OpenProcessToken(process, 8, out token)) throw new IOException("Owner unavailable"); }
    finally { CloseHandle(process); }
    try { using(var identity = new WindowsIdentity(token)) return identity.User.Value; }
    finally { CloseHandle(token); }
  }
  static string FileOwner(string file) {
    IntPtr owner, group, dacl, sacl, descriptor;
    if(GetNamedSecurityInfo(file, 1, 1, out owner, out group, out dacl, out sacl, out descriptor) != 0) throw new IOException("Registration unavailable");
    try { return new SecurityIdentifier(owner).Value; } finally { LocalFree(descriptor); }
  }
  static string PipeOwner(SafeFileHandle pipe) {
    IntPtr owner, group, dacl, sacl, descriptor;
    if(GetSecurityInfo(pipe, 6, 1, out owner, out group, out dacl, out sacl, out descriptor) != 0) throw new IOException("Window owner unavailable");
    try { return new SecurityIdentifier(owner).Value; } finally { LocalFree(descriptor); }
  }
  static uint Parent(uint pid) {
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if(snapshot == new IntPtr(-1)) throw new IOException("Process unavailable");
    try { var entry = new ProcessEntry(); entry.size = (uint)Marshal.SizeOf(entry);
      if(Process32First(snapshot, ref entry)) do { if(entry.pid == pid) return entry.parent; } while(Process32Next(snapshot, ref entry));
      throw new IOException("Process unavailable");
    } finally { CloseHandle(snapshot); }
  }
  static SecurityAttributes Attributes() {
    string owner = WindowsIdentity.GetCurrent().User.Value;
    string acl = "D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;" + owner + ")";
    foreach(string name in new [] { "CodexSandboxOffline", "CodexSandboxOnline" }) {
      try { string sid = ((SecurityIdentifier)new NTAccount(Environment.MachineName, name).Translate(typeof(SecurityIdentifier))).Value;
        acl += "(A;;0x0012019b;;;" + sid + ")";
      } catch(IdentityNotMappedException) { }
    }
    IntPtr descriptor; uint size;
    if(!ConvertStringSecurityDescriptorToSecurityDescriptor(acl, 1, out descriptor, out size)) throw new IOException("Pipe access unavailable");
    return new SecurityAttributes { length = Marshal.SizeOf(typeof(SecurityAttributes)), descriptor = descriptor };
  }
  static void Read(int id, Connection stream, int server = 0) {
    try {
      lock(stateLock) { streams.Add(id, stream); connecting.Remove(id); }
      if(server != 0) Output("accept:" + server + ":" + id);
      Output("open:" + id);
      byte[] bytes = new byte[4096]; int count;
      while(Io(stream, bytes, false, out count) && count != 0) Output("data:" + id + ":" + Convert.ToBase64String(bytes, 0, count));
    } catch(Exception) { }
    finally { lock(stateLock) { streams.Remove(id); if(server != 0) active[server]--; } stream.Close(); Output("close:" + id); }
  }
  static void Listen(int id, string address) {
    SecurityAttributes attributes = Attributes(); bool first = true;
    try {
      lock(stateLock) { servers.Add(id); active[id] = 0; }
      while(true) {
        var handle = CreateNamedPipe(address, 3 | 0x40000000u | (first ? 0x00080000u : 0u), 8, 255, 65536, 65536, 0, ref attributes);
        if(handle.IsInvalid) { handle.Dispose(); throw new IOException("Pipe unavailable"); }
        var stream = new Connection { handle = handle };
        lock(stateLock) { if(!servers.Contains(id)) { stream.Close(); return; } listeners[id] = stream; }
        if(first) { Output("listen:" + id); first = false; }
        int count;
        bool connected = Io(stream, null, false, out count);
        lock(stateLock) { listeners.Remove(id); if(!servers.Contains(id)) { stream.Close(); return; } }
        if(!connected) { stream.Close(); continue; }
        lock(stateLock) { if(active[id] >= 16) { stream.Close(); continue; } active[id]++; }
        int socket = Interlocked.Increment(ref nextSocket);
        new Thread(delegate() { Read(socket, stream, id); }) { IsBackground = true }.Start();
      }
    } catch(Exception) { Output("error:" + id); }
    finally { LocalFree(attributes.descriptor); }
  }
  static void Connect(int id, Connection stream, string address, uint host, uint server, string file, int timeout) {
    try {
      if(!address.StartsWith(@"\\.\pipe\arc-", StringComparison.Ordinal)) throw new IOException("Local address required");
      var clock = Stopwatch.StartNew();
      while(true) {
        int error;
        lock(stream) {
          if(stream.closed || clock.ElapsedMilliseconds >= timeout) throw new IOException("Connection unavailable");
          stream.handle = CreateFile(address, 0x0012019b, 0, IntPtr.Zero, 3, 0x40000000, IntPtr.Zero);
          error = Marshal.GetLastWin32Error();
          if(!stream.handle.IsInvalid) break;
          stream.handle.Dispose(); stream.handle = null;
        }
        if(error != 231 && error != 2) throw new IOException("Connection unavailable");
        uint remaining = (uint)Math.Max(1, Math.Min(25, timeout - clock.ElapsedMilliseconds));
        if(!WaitNamedPipe(address, remaining) && Marshal.GetLastWin32Error() == 2) lock(stream) { if(!stream.closed) Monitor.Wait(stream, (int)remaining); }
      }
      var handle = stream.handle;
      uint actual;
      if(handle.IsInvalid || !GetNamedPipeServerProcessId(handle, out actual) || actual != server || Parent(actual) != host) throw new IOException("Window identity unavailable");
      if(PipeOwner(handle) != (file.Length != 0 ? FileOwner(file) : Owner(host))) throw new IOException("Window owner unavailable");
      Read(id, stream);
    } catch(Exception) { stream.Close(); Output("close:" + id); }
    finally { lock(stateLock) connecting.Remove(id); }
  }
  static string Line() {
    var text = new StringBuilder(); int ch;
    while((ch = Console.In.Read()) >= 0) { if(ch == 10) return text.ToString(); if(text.Length >= 100000) throw new IOException("Input too large"); text.Append((char)ch); }
    return null;
  }
  static void Main() {
    ThreadPool.SetMinThreads(32, 32);
    try { string line;
      while((line = Line()) != null) {
        string[] parts = line.Split(':'); int id = int.Parse(parts[1]);
        if(parts[0] == "listen") { string address = Decode(parts[2]); new Thread(delegate() { Listen(id, address); }) { IsBackground = true }.Start(); }
        else if(parts[0] == "connect") { string address = Decode(parts[2]), file = Decode(parts[5]); uint host = uint.Parse(parts[3]), server = uint.Parse(parts[4]); int timeout = int.Parse(parts[6]); var stream = new Connection(); lock(stateLock) connecting.Add(id, stream); new Thread(delegate() { Connect(id, stream, address, host, server, file, timeout); }) { IsBackground = true }.Start(); }
        else if(parts[0] == "write") { Connection stream; lock(stateLock) streams.TryGetValue(id, out stream); if(stream != null) stream.Write(Convert.FromBase64String(parts[2])); }
        else if(parts[0] == "close") { Connection stream, listener; lock(stateLock) { if(!streams.TryGetValue(id, out stream)) connecting.TryGetValue(id, out stream); listeners.TryGetValue(id, out listener); servers.Remove(id); } if(stream != null) stream.Close(); if(listener != null) listener.Close(); }
      }
    } catch(Exception) { }
    Environment.Exit(0);
  }
}
`;
