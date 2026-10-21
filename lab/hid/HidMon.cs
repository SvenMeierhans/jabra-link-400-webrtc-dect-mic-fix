using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// Passively reads every HID input report of a device and timestamps it (read only; nothing is ever written).
// Used to watch a DECT dongle's session state: session start/end, hook switch, volume pulses.
public static class HidMon
{
    [StructLayout(LayoutKind.Sequential)]
    struct SP_DEVICE_INTERFACE_DATA { public int cbSize; public Guid InterfaceClassGuid; public int Flags; public IntPtr Reserved; }

    [StructLayout(LayoutKind.Sequential)]
    struct HIDP_CAPS
    {
        public ushort Usage, UsagePage, InputReportByteLength, OutputReportByteLength, FeatureReportByteLength;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] Reserved;
        public ushort NumberLinkCollectionNodes, NumberInputButtonCaps, NumberInputValueCaps, NumberInputDataIndices,
            NumberOutputButtonCaps, NumberOutputValueCaps, NumberOutputDataIndices,
            NumberFeatureButtonCaps, NumberFeatureValueCaps, NumberFeatureDataIndices;
    }

    [DllImport("hid.dll")] static extern void HidD_GetHidGuid(out Guid g);
    [DllImport("hid.dll")] static extern bool HidD_GetPreparsedData(SafeFileHandle h, out IntPtr p);
    [DllImport("hid.dll")] static extern bool HidD_FreePreparsedData(IntPtr p);
    [DllImport("hid.dll")] static extern int HidP_GetCaps(IntPtr p, out HIDP_CAPS caps);
    [DllImport("setupapi.dll", SetLastError = true)] static extern IntPtr SetupDiGetClassDevs(ref Guid g, IntPtr e, IntPtr h, int flags);
    [DllImport("setupapi.dll", SetLastError = true)] static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr info, ref Guid g, int idx, ref SP_DEVICE_INTERFACE_DATA d);
    [DllImport("setupapi.dll", CharSet = CharSet.Auto, SetLastError = true)] static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr set, ref SP_DEVICE_INTERFACE_DATA d, IntPtr detail, int size, out int req, IntPtr info);
    [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadFile(SafeFileHandle h, byte[] buf, int len, out int read, IntPtr ov);

    static readonly object Lock = new object();
    static StreamWriter Out;

    static void Emit(string line)
    {
        lock (Lock) { Out.WriteLine(line); Out.Flush(); }
    }

    static long NowMs() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }

    /// <param name="logPath">Output file. Lines: "epochMs colNN[usagePage:usage] hex bytes", comments start with '#'.</param>
    /// <param name="seconds">How long to monitor.</param>
    /// <param name="match">Substring of the HID device path, e.g. "vid_0b0e&amp;pid_1131" (case-insensitive).</param>
    public static void Run(string logPath, int seconds, string match)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(logPath)));
        Out = new StreamWriter(new FileStream(logPath, FileMode.Create, FileAccess.Write, FileShare.ReadWrite));
        Guid g; HidD_GetHidGuid(out g);
        IntPtr set = SetupDiGetClassDevs(ref g, IntPtr.Zero, IntPtr.Zero, 0x12); // DIGCF_PRESENT | DIGCF_DEVICEINTERFACE
        var d = new SP_DEVICE_INTERFACE_DATA(); d.cbSize = Marshal.SizeOf(d);
        for (int i = 0; SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref g, i, ref d); i++)
        {
            int req;
            SetupDiGetDeviceInterfaceDetail(set, ref d, IntPtr.Zero, 0, out req, IntPtr.Zero);
            IntPtr buf = Marshal.AllocHGlobal(req);
            Marshal.WriteInt32(buf, IntPtr.Size == 8 ? 8 : 6); // cbSize of SP_DEVICE_INTERFACE_DETAIL_DATA
            if (!SetupDiGetDeviceInterfaceDetail(set, ref d, buf, req, out req, IntPtr.Zero)) { Marshal.FreeHGlobal(buf); continue; }
            string path = Marshal.PtrToStringAuto(new IntPtr(buf.ToInt64() + 4));
            Marshal.FreeHGlobal(buf);
            if (path.IndexOf(match, StringComparison.OrdinalIgnoreCase) < 0) continue;

            // GENERIC_READ only, shared with everybody else: we never interfere with other readers or writers.
            var h = CreateFile(path, 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
            int ci = path.IndexOf("col", StringComparison.OrdinalIgnoreCase);
            string tag = ci < 0 ? "col??" : path.Substring(ci, 5);
            if (h.IsInvalid) { Emit("# open FAILED " + path + " err=" + Marshal.GetLastWin32Error()); continue; }
            IntPtr pp; HIDP_CAPS caps;
            if (!HidD_GetPreparsedData(h, out pp) || HidP_GetCaps(pp, out caps) < 0) { Emit("# caps FAILED " + path); continue; }
            HidD_FreePreparsedData(pp);
            Emit(string.Format("# {0} usagePage=0x{1:X4} usage=0x{2:X4} in={3} out={4} feat={5} | {6}", tag, caps.UsagePage, caps.Usage, caps.InputReportByteLength, caps.OutputReportByteLength, caps.FeatureReportByteLength, path));
            if (caps.InputReportByteLength == 0) continue;

            int len = caps.InputReportByteLength;
            string label = string.Format("{0}[{1:X4}:{2:X4}]", tag, caps.UsagePage, caps.Usage);
            var th = new Thread(() =>
            {
                var b = new byte[len];
                while (true)
                {
                    int n;
                    if (!ReadFile(h, b, len, out n, IntPtr.Zero)) { Emit("# read ended " + label + " err=" + Marshal.GetLastWin32Error()); return; }
                    var sb = new StringBuilder();
                    for (int k = 0; k < n; k++) sb.Append(b[k].ToString("X2")).Append(' ');
                    Emit(NowMs() + " " + label + " " + sb.ToString().Trim());
                }
            });
            th.IsBackground = true; th.Start();
        }
        SetupDiDestroyDeviceInfoList(set);
        Emit("# started " + NowMs());
        Thread.Sleep(seconds * 1000);
        Emit("# stopped " + NowMs());
    }
}
