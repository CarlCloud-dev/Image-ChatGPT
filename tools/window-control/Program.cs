using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

internal static class Program
{
    private const int SwHide = 0;
    private const int SwShow = 5;
    private const int SwRestore = 9;
    private const uint SwpShowWindow = 0x0040;

    public static int Main(string[] args)
    {
        var parsed = ParseArgs(args);
        var action = parsed.GetValueOrDefault("action", "visible").ToLowerInvariant();
        var targetPid = int.TryParse(parsed.GetValueOrDefault("target-pid", "0"), out var pidValue) ? pidValue : 0;

        try
        {
            var windows = FindWindows(targetPid);
            if (windows.Count == 0)
            {
                WriteJson(new
                {
                    ok = false,
                    visible = false,
                    error = "window_not_found",
                    targetPid,
                    count = 0
                });
                return 2;
            }

            var target = SelectTarget(windows);
            if (action == "hide")
            {
                foreach (var window in windows)
                {
                    NativeMethods.ShowWindow(window.Hwnd, SwHide);
                }

                WriteJson(new
                {
                    ok = true,
                    visible = false,
                    pid = target.Pid,
                    hwnd = target.Hwnd.ToInt64(),
                    count = windows.Count,
                    title = target.Title
                });
                return 0;
            }

            if (action == "show")
            {
                foreach (var window in windows.Where(x => x.Hwnd != target.Hwnd))
                {
                    NativeMethods.ShowWindow(window.Hwnd, SwHide);
                }

                NativeMethods.ShowWindow(target.Hwnd, SwRestore);
                NativeMethods.SetWindowPos(target.Hwnd, IntPtr.Zero, 0, 0, 1280, 900, SwpShowWindow);
                NativeMethods.ShowWindow(target.Hwnd, SwShow);
                NativeMethods.BringWindowToTop(target.Hwnd);
                NativeMethods.SetForegroundWindow(target.Hwnd);

                WriteJson(new
                {
                    ok = true,
                    visible = true,
                    pid = target.Pid,
                    hwnd = target.Hwnd.ToInt64(),
                    count = windows.Count,
                    title = target.Title
                });
                return 0;
            }

            var visible = windows.Any(x => NativeMethods.IsWindowVisible(x.Hwnd) && !NativeMethods.IsIconic(x.Hwnd) && !x.Offscreen);
            WriteJson(new
            {
                ok = true,
                visible,
                pid = target.Pid,
                hwnd = target.Hwnd.ToInt64(),
                count = windows.Count,
                title = target.Title
            });
            return 0;
        }
        catch (Exception ex)
        {
            WriteJson(new
            {
                ok = false,
                visible = false,
                error = ex.Message,
                targetPid
            });
            return 1;
        }
    }

    private static Dictionary<string, string> ParseArgs(string[] args)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < args.Length; i++)
        {
            var key = args[i];
            if (!key.StartsWith("--", StringComparison.Ordinal)) continue;
            var name = key[2..];
            var value = i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal)
                ? args[++i]
                : "true";
            result[name] = value;
        }
        return result;
    }

    private static List<WindowInfo> FindWindows(int targetPid)
    {
        var result = new List<WindowInfo>();
        var seen = new HashSet<IntPtr>();

        void AddWindow(IntPtr hwnd, int ownerPid)
        {
            if (hwnd == IntPtr.Zero || !seen.Add(hwnd)) return;
            var info = ReadWindow(hwnd, ownerPid);
            if (IsChromeWindow(info))
            {
                result.Add(info);
            }
        }

        if (targetPid > 0)
        {
            try
            {
                using var proc = Process.GetProcessById(targetPid);
                if (proc.MainWindowHandle != IntPtr.Zero)
                {
                    AddWindow(proc.MainWindowHandle, targetPid);
                }
            }
            catch
            {
                // The process may have exited; EnumWindows and fallback matching can still succeed.
            }
        }

        NativeMethods.EnumWindows((hwnd, _) =>
        {
            NativeMethods.GetWindowThreadProcessId(hwnd, out var ownerPid);
            var owner = (int)ownerPid;
            var info = ReadWindow(hwnd, owner);
            if (targetPid > 0 && owner == targetPid)
            {
                AddWindow(hwnd, owner);
            }
            else if (info.Offscreen && IsChromeWindow(info))
            {
                AddWindow(hwnd, owner);
            }
            else if (IsChromeWindow(info) && info.Title.Contains("ChatGPT", StringComparison.OrdinalIgnoreCase))
            {
                AddWindow(hwnd, owner);
            }
            return true;
        }, IntPtr.Zero);

        return result;
    }

    private static bool IsChromeWindow(WindowInfo info)
    {
        try
        {
            using var proc = Process.GetProcessById(info.Pid);
            return proc.ProcessName.Equals("chrome", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static WindowInfo SelectTarget(List<WindowInfo> windows)
    {
        return windows.FirstOrDefault(x =>
                   x.Title.Contains("ChatGPT", StringComparison.OrdinalIgnoreCase)) ??
               windows.FirstOrDefault(x => !string.IsNullOrWhiteSpace(x.Title)) ??
               windows[0];
    }

    private static WindowInfo ReadWindow(IntPtr hwnd, int ownerPid)
    {
        var className = ReadClassName(hwnd);
        var title = ReadWindowText(hwnd);
        NativeMethods.GetWindowRect(hwnd, out var rect);
        return new WindowInfo(
            hwnd,
            ownerPid,
            className,
            title,
            NativeMethods.IsWindowVisible(hwnd),
            NativeMethods.IsIconic(hwnd),
            rect.Left < -10000 || rect.Top < -10000
        );
    }

    private static string ReadClassName(IntPtr hwnd)
    {
        var builder = new StringBuilder(256);
        NativeMethods.GetClassName(hwnd, builder, builder.Capacity);
        return builder.ToString();
    }

    private static string ReadWindowText(IntPtr hwnd)
    {
        var builder = new StringBuilder(512);
        NativeMethods.GetWindowText(hwnd, builder, builder.Capacity);
        return builder.ToString();
    }

    private static void WriteJson(object value)
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.WriteLine(JsonSerializer.Serialize(value));
    }
}

internal sealed record WindowInfo(
    IntPtr Hwnd,
    int Pid,
    string ClassName,
    string Title,
    bool Visible,
    bool Minimized,
    bool Offscreen
);

internal static partial class NativeMethods
{
    internal delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    internal struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [LibraryImport("user32.dll")]
    internal static partial uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool IsWindowVisible(IntPtr hwnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool IsIconic(IntPtr hwnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool ShowWindow(IntPtr hwnd, int command);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool SetForegroundWindow(IntPtr hwnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool BringWindowToTop(IntPtr hwnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool SetWindowPos(IntPtr hwnd, IntPtr hwndInsertAfter, int x, int y, int cx, int cy, uint flags);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool GetWindowRect(IntPtr hwnd, out Rect rect);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetClassName(IntPtr hwnd, StringBuilder className, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);
}
