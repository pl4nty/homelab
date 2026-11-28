using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace WindowsVmMcp
{
    public static class Agent
    {
        const int Chunk = 65536;
        const int MaxOutput = 4 * 1024 * 1024;

        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        static readonly SemaphoreSlim SendLock = new SemaphoreSlim(1, 1);
        static readonly Dictionary<string, Exec> Execs = new Dictionary<string, Exec>();
        static ClientWebSocket socket;
        static string sourcePath;
        static string logPath;
        static int nextExec;

        public static void Run(string dir)
        {
            Native.SetProcessDPIAware();
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            sourcePath = Path.Combine(dir, "Agent.cs");
            logPath = Path.Combine(dir, "agent.log");
            var config = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(dir, "config.json")));
            var url = (string)config["url"];
            var token = (string)config["token"];
            while (true)
            {
                try
                {
                    Session(url, token).Wait();
                }
                catch (Exception e)
                {
                    Log(e.GetBaseException().Message);
                }
                Thread.Sleep(5000);
            }
        }

        static void Log(string message)
        {
            try
            {
                if (File.Exists(logPath) && new FileInfo(logPath).Length > 1024 * 1024) File.Delete(logPath);
                File.AppendAllText(logPath, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine);
            }
            catch (IOException) { }
        }

        public static string SourceHash(string source)
        {
            using (var sha = SHA256.Create())
            {
                var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(source.Replace("\r\n", "\n").Trim()));
                return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
            }
        }

        static async Task Session(string url, string token)
        {
            using (var ws = new ClientWebSocket())
            {
                ws.Options.SetRequestHeader("Authorization", "Bearer " + token);
                ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
                await ws.ConnectAsync(new Uri(url), CancellationToken.None);
                socket = ws;
                Log("connected " + url);
                var screen = SystemInformation.VirtualScreen;
                await Send(new Dictionary<string, object> {
                    { "op", "hello" },
                    { "agent", SourceHash(File.ReadAllText(sourcePath)) },
                    { "user", Environment.UserName },
                    { "session", Process.GetCurrentProcess().SessionId },
                    { "os", Environment.OSVersion.VersionString },
                    { "screen", new[] { screen.Width, screen.Height } },
                });
                while (ws.State == WebSocketState.Open)
                {
                    var message = await Receive(ws);
                    if (message == null) break;
                    var request = Json.Deserialize<Dictionary<string, object>>(message);
                    var handling = Task.Run(() => Handle(request));
                }
            }
        }

        static async Task<string> Receive(ClientWebSocket ws)
        {
            var buffer = new byte[Chunk];
            using (var ms = new MemoryStream())
            {
                while (true)
                {
                    var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
                    if (result.MessageType == WebSocketMessageType.Close) return null;
                    ms.Write(buffer, 0, result.Count);
                    if (result.EndOfMessage) return Encoding.UTF8.GetString(ms.ToArray());
                }
            }
        }

        static async Task Send(object message)
        {
            var bytes = Encoding.UTF8.GetBytes(Json.Serialize(message));
            await SendLock.WaitAsync();
            try
            {
                var offset = 0;
                do
                {
                    var count = Math.Min(Chunk, bytes.Length - offset);
                    var last = offset + count >= bytes.Length;
                    await socket.SendAsync(new ArraySegment<byte>(bytes, offset, count), WebSocketMessageType.Text, last, CancellationToken.None);
                    offset += count;
                } while (offset < bytes.Length);
            }
            finally
            {
                SendLock.Release();
            }
        }

        static async Task Handle(Dictionary<string, object> request)
        {
            var response = new Dictionary<string, object>();
            if (request.ContainsKey("id")) response["id"] = request["id"];
            try
            {
                response["result"] = Dispatch((string)request["op"], request);
            }
            catch (Exception e)
            {
                response["error"] = e.GetBaseException().Message;
            }
            try
            {
                await Send(response);
            }
            catch (Exception e)
            {
                Log("send failed: " + e.Message);
            }
        }

        static object Dispatch(string op, Dictionary<string, object> r)
        {
            switch (op)
            {
                case "info": return Info();
                case "exec": return StartExec(Str(r, "command"), Str(r, "args"), Str(r, "cwd"));
                case "exec_poll": return PollExec(Str(r, "exec_id"), Int(r, "wait_ms", 0));
                case "exec_kill": return KillExec(Str(r, "exec_id"));
                case "file_read": return FileRead(Str(r, "path"), Long(r, "offset", 0), Int(r, "length", 1024 * 1024));
                case "file_write": return FileWrite(Str(r, "path"), Str(r, "data"), Bool(r, "append"));
                case "file_list": return FileList(Str(r, "path"));
                case "screenshot": return Screenshot();
                case "mouse": return Input.Mouse(Str(r, "action"), Int(r, "x", -1), Int(r, "y", -1), Int(r, "x2", -1), Int(r, "y2", -1), Int(r, "dx", 0), Int(r, "dy", 0));
                case "keyboard": return Input.Keyboard(Str(r, "action"), Str(r, "text"), Int(r, "repeat", 1));
                case "windows": return WindowList.Run(Str(r, "action"), Long(r, "handle", 0));
                case "update": return Update(Str(r, "source"));
                default: throw new ArgumentException("unknown op " + op);
            }
        }

        static string Str(Dictionary<string, object> r, string key)
        {
            object v;
            return r.TryGetValue(key, out v) && v != null ? v.ToString() : null;
        }

        static int Int(Dictionary<string, object> r, string key, int fallback)
        {
            object v;
            return r.TryGetValue(key, out v) && v != null ? Convert.ToInt32(v) : fallback;
        }

        static long Long(Dictionary<string, object> r, string key, long fallback)
        {
            object v;
            return r.TryGetValue(key, out v) && v != null ? Convert.ToInt64(v) : fallback;
        }

        static bool Bool(Dictionary<string, object> r, string key)
        {
            object v;
            return r.TryGetValue(key, out v) && v is bool && (bool)v;
        }

        static object Info()
        {
            var screen = SystemInformation.VirtualScreen;
            Native.POINT cursor;
            Native.GetCursorPos(out cursor);
            return new Dictionary<string, object> {
                { "user", Environment.UserName },
                { "session", Process.GetCurrentProcess().SessionId },
                { "os", Environment.OSVersion.VersionString },
                { "screen", new[] { screen.Width, screen.Height } },
                { "cursor", new[] { cursor.X, cursor.Y } },
            };
        }

        class Exec
        {
            public Process Process;
            public readonly List<byte> Stdout = new List<byte>();
            public readonly List<byte> Stderr = new List<byte>();
            public int StdoutRead;
            public int StderrRead;
            public Task Pumps;
        }

        static readonly Encoding StrictUtf8 = new UTF8Encoding(false, true);
        static readonly Encoding Oem = Encoding.GetEncoding(System.Globalization.CultureInfo.CurrentCulture.TextInfo.OEMCodePage);

        static Task Pump(Stream stream, List<byte> sink)
        {
            return Task.Run(() =>
            {
                var bytes = new byte[8192];
                int n;
                while ((n = stream.Read(bytes, 0, bytes.Length)) > 0)
                {
                    lock (sink)
                    {
                        if (sink.Count < MaxOutput) sink.AddRange(bytes.Take(n));
                    }
                }
            });
        }

        static object StartExec(string command, string args, string cwd)
        {
            var psi = new ProcessStartInfo(command, args ?? "")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = string.IsNullOrEmpty(cwd) ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) : cwd,
            };
            var exec = new Exec { Process = Process.Start(psi) };
            exec.Process.StandardInput.Close();
            exec.Pumps = Task.WhenAll(
                Pump(exec.Process.StandardOutput.BaseStream, exec.Stdout),
                Pump(exec.Process.StandardError.BaseStream, exec.Stderr));
            var id = "exec-" + Interlocked.Increment(ref nextExec);
            lock (Execs) Execs[id] = exec;
            return new Dictionary<string, object> { { "exec_id", id }, { "pid", exec.Process.Id } };
        }

        static Exec GetExec(string id)
        {
            Exec exec;
            lock (Execs)
            {
                if (!Execs.TryGetValue(id ?? "", out exec)) throw new ArgumentException("unknown execID " + id);
            }
            return exec;
        }

        static string Drain(List<byte> sink, ref int read, bool final)
        {
            byte[] bytes;
            lock (sink)
            {
                bytes = sink.GetRange(read, sink.Count - read).ToArray();
            }
            var length = bytes.Length;
            if (!final)
            {
                var lead = length - 1;
                while (lead >= 0 && lead > length - 4 && (bytes[lead] & 0xC0) == 0x80) lead--;
                if (lead >= 0 && bytes[lead] >= 0xC0)
                {
                    var size = bytes[lead] >= 0xF0 ? 4 : bytes[lead] >= 0xE0 ? 3 : 2;
                    if (length - lead < size) length = lead;
                }
            }
            read += length;
            try
            {
                return StrictUtf8.GetString(bytes, 0, length);
            }
            catch (DecoderFallbackException)
            {
                return Oem.GetString(bytes, 0, length);
            }
        }

        static object PollExec(string id, int waitMs)
        {
            var exec = GetExec(id);
            var exited = exec.Process.WaitForExit(Math.Max(0, waitMs));
            if (exited) exec.Pumps.Wait(5000);
            var result = new Dictionary<string, object> {
                { "exec_id", id },
                { "running", !exited },
                { "stdout", Drain(exec.Stdout, ref exec.StdoutRead, exited) },
                { "stderr", Drain(exec.Stderr, ref exec.StderrRead, exited) },
            };
            if (exited)
            {
                result["exit_code"] = exec.Process.ExitCode;
                lock (Execs) Execs.Remove(id);
            }
            return result;
        }

        static object KillExec(string id)
        {
            var exec = GetExec(id);
            if (!exec.Process.HasExited)
            {
                Process.Start(new ProcessStartInfo("taskkill", "/F /T /PID " + exec.Process.Id) { UseShellExecute = false, CreateNoWindow = true }).WaitForExit();
            }
            return PollExec(id, 5000);
        }

        static object FileRead(string path, long offset, int length)
        {
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                fs.Seek(offset, SeekOrigin.Begin);
                var buffer = new byte[(int)Math.Max(0, Math.Min(length, fs.Length - offset))];
                var read = 0;
                while (read < buffer.Length)
                {
                    var n = fs.Read(buffer, read, buffer.Length - read);
                    if (n == 0) break;
                    read += n;
                }
                return new Dictionary<string, object> {
                    { "size", fs.Length },
                    { "offset", offset },
                    { "data", Convert.ToBase64String(buffer, 0, read) },
                };
            }
        }

        static object FileWrite(string path, string data, bool append)
        {
            var bytes = Convert.FromBase64String(data ?? "");
            var parent = Path.GetDirectoryName(Path.GetFullPath(path));
            if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
            using (var fs = new FileStream(path, append ? FileMode.Append : FileMode.Create, FileAccess.Write))
            {
                fs.Write(bytes, 0, bytes.Length);
                return new Dictionary<string, object> { { "size", fs.Length } };
            }
        }

        static object FileList(string path)
        {
            var dir = new DirectoryInfo(path);
            var entries = dir.EnumerateFileSystemInfos().Select(e => (object)new Dictionary<string, object> {
                { "name", e.Name },
                { "dir", (e.Attributes & FileAttributes.Directory) != 0 },
                { "size", e is FileInfo ? ((FileInfo)e).Length : 0 },
                { "modified", e.LastWriteTimeUtc.ToString("o") },
            }).ToArray();
            return new Dictionary<string, object> { { "path", dir.FullName }, { "entries", entries } };
        }

        static object Screenshot()
        {
            var bounds = SystemInformation.VirtualScreen;
            using (var bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(bitmap))
                {
                    g.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
                    Native.POINT cursor;
                    if (Native.GetCursorPos(out cursor))
                    {
                        Cursors.Arrow.Draw(g, new Rectangle(cursor.X - bounds.Left, cursor.Y - bounds.Top, 32, 32));
                    }
                }
                using (var ms = new MemoryStream())
                {
                    bitmap.Save(ms, ImageFormat.Png);
                    return new Dictionary<string, object> {
                        { "width", bounds.Width },
                        { "height", bounds.Height },
                        { "png", Convert.ToBase64String(ms.ToArray()) },
                    };
                }
            }
        }

        static object Update(string source)
        {
            File.Copy(sourcePath, sourcePath + ".bak", true);
            File.WriteAllText(sourcePath, source);
            Log("updated to " + SourceHash(source));
            Task.Run(() =>
            {
                Thread.Sleep(1000);
                Environment.Exit(0);
            });
            return new Dictionary<string, object> { { "agent", SourceHash(source) } };
        }
    }

    static class Input
    {
        const uint MouseMove = 0x0001;
        const uint LeftDown = 0x0002;
        const uint LeftUp = 0x0004;
        const uint RightDown = 0x0008;
        const uint RightUp = 0x0010;
        const uint MiddleDown = 0x0020;
        const uint MiddleUp = 0x0040;
        const uint Wheel = 0x0800;
        const uint HWheel = 0x1000;
        const uint KeyExtended = 0x0001;
        const uint KeyUp = 0x0002;
        const uint KeyUnicode = 0x0004;

        static readonly Dictionary<string, ushort> KeyNames = new Dictionary<string, ushort> {
            { "ctrl", 0x11 }, { "control", 0x11 }, { "shift", 0x10 }, { "alt", 0x12 }, { "menu", 0x12 },
            { "win", 0x5B }, { "super", 0x5B }, { "meta", 0x5B }, { "cmd", 0x5B },
            { "enter", 0x0D }, { "return", 0x0D }, { "esc", 0x1B }, { "escape", 0x1B }, { "tab", 0x09 },
            { "space", 0x20 }, { "backspace", 0x08 }, { "delete", 0x2E }, { "del", 0x2E }, { "insert", 0x2D },
            { "home", 0x24 }, { "end", 0x23 }, { "pageup", 0x21 }, { "pgup", 0x21 }, { "pagedown", 0x22 }, { "pgdn", 0x22 },
            { "left", 0x25 }, { "up", 0x26 }, { "right", 0x27 }, { "down", 0x28 },
            { "printscreen", 0x2C }, { "print", 0x2C }, { "capslock", 0x14 }, { "numlock", 0x90 }, { "scrolllock", 0x91 },
            { "pause", 0x13 }, { "apps", 0x5D }, { "contextmenu", 0x5D },
        };

        static readonly HashSet<ushort> Extended = new HashSet<ushort> { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5D };

        static Native.INPUT MouseInput(uint flags, int data)
        {
            var input = new Native.INPUT { type = 0 };
            input.u.mi.dwFlags = flags;
            input.u.mi.mouseData = data;
            return input;
        }

        static Native.INPUT KeyInput(ushort vk, ushort scan, uint flags)
        {
            var input = new Native.INPUT { type = 1 };
            input.u.ki.wVk = vk;
            input.u.ki.wScan = scan;
            input.u.ki.dwFlags = flags;
            return input;
        }

        static void SendInputs(params Native.INPUT[] inputs)
        {
            if (Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Native.INPUT))) != inputs.Length)
            {
                throw new InvalidOperationException("SendInput failed with error " + Marshal.GetLastWin32Error() + "; the desktop may be locked or on the secure desktop");
            }
        }

        static void MoveTo(int x, int y)
        {
            if (x < 0 || y < 0) return;
            if (!Native.SetCursorPos(x, y)) throw new InvalidOperationException("SetCursorPos failed");
            SendInputs(MouseInput(MouseMove, 0));
        }

        static void Click(uint down, uint up, int count)
        {
            for (var i = 0; i < count; i++)
            {
                SendInputs(MouseInput(down, 0), MouseInput(up, 0));
                Thread.Sleep(50);
            }
        }

        public static object Mouse(string action, int x, int y, int x2, int y2, int dx, int dy)
        {
            switch (action)
            {
                case "move": MoveTo(x, y); break;
                case "left_click": MoveTo(x, y); Click(LeftDown, LeftUp, 1); break;
                case "double_click": MoveTo(x, y); Click(LeftDown, LeftUp, 2); break;
                case "triple_click": MoveTo(x, y); Click(LeftDown, LeftUp, 3); break;
                case "right_click": MoveTo(x, y); Click(RightDown, RightUp, 1); break;
                case "middle_click": MoveTo(x, y); Click(MiddleDown, MiddleUp, 1); break;
                case "left_down": MoveTo(x, y); SendInputs(MouseInput(LeftDown, 0)); break;
                case "left_up": MoveTo(x, y); SendInputs(MouseInput(LeftUp, 0)); break;
                case "drag":
                    MoveTo(x, y);
                    SendInputs(MouseInput(LeftDown, 0));
                    for (var i = 1; i <= 10; i++)
                    {
                        Thread.Sleep(20);
                        MoveTo(x + (x2 - x) * i / 10, y + (y2 - y) * i / 10);
                    }
                    SendInputs(MouseInput(LeftUp, 0));
                    break;
                case "scroll":
                    MoveTo(x, y);
                    if (dy != 0) SendInputs(MouseInput(Wheel, -dy * 120));
                    if (dx != 0) SendInputs(MouseInput(HWheel, dx * 120));
                    break;
                case "position": break;
                default: throw new ArgumentException("unknown mouse action " + action);
            }
            Native.POINT cursor;
            Native.GetCursorPos(out cursor);
            return new Dictionary<string, object> { { "cursor", new[] { cursor.X, cursor.Y } } };
        }

        static ushort KeyCode(string name)
        {
            var key = name.Trim().ToLowerInvariant().Replace("_", "");
            ushort vk;
            if (KeyNames.TryGetValue(key, out vk)) return vk;
            if (key.Length > 1 && key[0] == 'f')
            {
                int n;
                if (int.TryParse(key.Substring(1), out n) && n >= 1 && n <= 24) return (ushort)(0x6F + n);
            }
            if (key.Length == 1)
            {
                var scan = Native.VkKeyScan(key[0]);
                if (scan != -1) return (ushort)(scan & 0xFF);
            }
            throw new ArgumentException("unknown key " + name);
        }

        static Native.INPUT VirtualKey(ushort vk, bool up)
        {
            var flags = (Extended.Contains(vk) ? KeyExtended : 0) | (up ? KeyUp : 0);
            return KeyInput(vk, 0, flags);
        }

        public static object Keyboard(string action, string text, int repeat)
        {
            switch (action)
            {
                case "type":
                    foreach (var c in text ?? "")
                    {
                        if (c == '\r') continue;
                        if (c == '\n') SendInputs(VirtualKey(0x0D, false), VirtualKey(0x0D, true));
                        else if (c == '\t') SendInputs(VirtualKey(0x09, false), VirtualKey(0x09, true));
                        else SendInputs(KeyInput(0, c, KeyUnicode), KeyInput(0, c, KeyUnicode | KeyUp));
                    }
                    break;
                case "key":
                    foreach (var combo in (text ?? "").Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries))
                    {
                        var codes = combo.Split('+').Select(k => KeyCode(k)).ToArray();
                        for (var i = 0; i < Math.Max(1, repeat); i++)
                        {
                            SendInputs(codes.Select(vk => VirtualKey(vk, false)).Concat(codes.Reverse().Select(vk => VirtualKey(vk, true))).ToArray());
                            Thread.Sleep(30);
                        }
                    }
                    break;
                default: throw new ArgumentException("unknown keyboard action " + action);
            }
            return new Dictionary<string, object> { { "ok", true } };
        }
    }

    static class WindowList
    {
        static object Describe(IntPtr h, IntPtr foreground)
        {
            Native.RECT rect;
            Native.GetWindowRect(h, out rect);
            uint pid;
            Native.GetWindowThreadProcessId(h, out pid);
            string process = null;
            try { process = Process.GetProcessById((int)pid).ProcessName; } catch (ArgumentException) { }
            var title = new StringBuilder(Native.GetWindowTextLength(h) + 1);
            Native.GetWindowText(h, title, title.Capacity);
            return new Dictionary<string, object> {
                { "handle", h.ToInt64() },
                { "title", title.ToString() },
                { "process", process },
                { "pid", pid },
                { "rect", new[] { rect.Left, rect.Top, rect.Right, rect.Bottom } },
                { "minimized", Native.IsIconic(h) },
                { "maximized", Native.IsZoomed(h) },
                { "foreground", h == foreground },
            };
        }

        static bool IsAppWindow(IntPtr h)
        {
            if (!Native.IsWindowVisible(h) || Native.GetWindowTextLength(h) == 0) return false;
            if (Native.GetWindow(h, 4) != IntPtr.Zero) return false;
            if ((Native.GetWindowLong(h, -20) & 0x80) != 0) return false;
            int cloaked;
            return Native.DwmGetWindowAttribute(h, 14, out cloaked, 4) != 0 || cloaked == 0;
        }

        public static object Run(string action, long handle)
        {
            var foreground = Native.GetForegroundWindow();
            if (action == "list")
            {
                var windows = new List<object>();
                Native.EnumWindows((h, l) =>
                {
                    if (IsAppWindow(h)) windows.Add(Describe(h, foreground));
                    return true;
                }, IntPtr.Zero);
                return new Dictionary<string, object> { { "windows", windows } };
            }
            var hwnd = new IntPtr(handle);
            if (!Native.IsWindow(hwnd)) throw new ArgumentException("no window with handle " + handle);
            switch (action)
            {
                case "focus":
                    if (Native.IsIconic(hwnd)) Native.ShowWindow(hwnd, 9);
                    Native.keybd_event(0x12, 0, 0, UIntPtr.Zero);
                    Native.keybd_event(0x12, 0, 2, UIntPtr.Zero);
                    Native.SetForegroundWindow(hwnd);
                    break;
                case "minimize": Native.ShowWindow(hwnd, 6); break;
                case "maximize": Native.ShowWindow(hwnd, 3); break;
                case "restore": Native.ShowWindow(hwnd, 9); break;
                case "close": Native.PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero); break;
                default: throw new ArgumentException("unknown window action " + action);
            }
            Thread.Sleep(200);
            return Native.IsWindow(hwnd) ? Describe(hwnd, Native.GetForegroundWindow()) : new Dictionary<string, object> { { "handle", handle }, { "closed", true } };
        }
    }

    static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public InputUnion u; }

        public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        [DllImport("user32.dll")] public static extern short VkKeyScan(char c);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
        [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
    }
}
