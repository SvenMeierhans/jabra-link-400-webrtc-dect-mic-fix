using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

// Read-only: dumps the report layout (usages, report IDs, bit sizes) of every HID collection of a device and
// can COMPUTE (not send) the output report that sets one specific usage. Nothing is ever written to the device.
public static class HidInfo
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
    [DllImport("hid.dll")] static extern int HidP_GetButtonCaps(int type, byte[] caps, ref ushort len, IntPtr p);
    [DllImport("hid.dll")] static extern int HidP_GetValueCaps(int type, byte[] caps, ref ushort len, IntPtr p);
    [DllImport("hid.dll")] static extern int HidP_InitializeReportForID(int type, byte id, IntPtr pp, byte[] report, int len);
    [DllImport("hid.dll")] static extern int HidP_SetUsages(int type, ushort page, ushort link, ushort[] usages, ref int n, IntPtr pp, byte[] report, int len);
    [DllImport("setupapi.dll", SetLastError = true)] static extern IntPtr SetupDiGetClassDevs(ref Guid g, IntPtr e, IntPtr h, int flags);
    [DllImport("setupapi.dll", SetLastError = true)] static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr info, ref Guid g, int idx, ref SP_DEVICE_INTERFACE_DATA d);
    [DllImport("setupapi.dll", CharSet = CharSet.Auto, SetLastError = true)] static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr set, ref SP_DEVICE_INTERFACE_DATA d, IntPtr detail, int size, out int req, IntPtr info);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);

    // HIDP_BUTTON_CAPS and HIDP_VALUE_CAPS are both 72 bytes on 64-bit Windows; fields are read by offset.
    const int CapSize = 72;
    static readonly string[] Types = { "INPUT", "OUTPUT", "FEATURE" };

    static ushort U16(byte[] b, int o) { return BitConverter.ToUInt16(b, o); }
    static int I32(byte[] b, int o) { return BitConverter.ToInt32(b, o); }

    // Enumerates present HID collections whose device path contains `match` (and `col`, if given, e.g. "col02").
    static void ForEachCollection(string match, string col, Action<string, SafeFileHandle, IntPtr> action)
    {
        Guid g; HidD_GetHidGuid(out g);
        IntPtr set = SetupDiGetClassDevs(ref g, IntPtr.Zero, IntPtr.Zero, 0x12); // DIGCF_PRESENT | DIGCF_DEVICEINTERFACE
        var d = new SP_DEVICE_INTERFACE_DATA(); d.cbSize = Marshal.SizeOf(d);
        for (int i = 0; SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref g, i, ref d); i++)
        {
            int req;
            SetupDiGetDeviceInterfaceDetail(set, ref d, IntPtr.Zero, 0, out req, IntPtr.Zero);
            IntPtr buf = Marshal.AllocHGlobal(req);
            Marshal.WriteInt32(buf, IntPtr.Size == 8 ? 8 : 6);
            if (!SetupDiGetDeviceInterfaceDetail(set, ref d, buf, req, out req, IntPtr.Zero)) { Marshal.FreeHGlobal(buf); continue; }
            string path = Marshal.PtrToStringAuto(new IntPtr(buf.ToInt64() + 4));
            Marshal.FreeHGlobal(buf);
            if (path.IndexOf(match, StringComparison.OrdinalIgnoreCase) < 0) continue;
            if (col != null && path.IndexOf("&" + col + "#", StringComparison.OrdinalIgnoreCase) < 0) continue;
            var h = CreateFile(path, 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero); // read-only, shared
            IntPtr pp;
            if (h.IsInvalid || !HidD_GetPreparsedData(h, out pp)) continue;
            try { action(path, h, pp); } finally { HidD_FreePreparsedData(pp); }
        }
    }

    public static string Dump(string match)
    {
        var sb = new StringBuilder();
        ForEachCollection(match, null, (path, h, pp) =>
        {
            int ci = path.IndexOf("col", StringComparison.OrdinalIgnoreCase);
            sb.AppendLine("=== " + (ci < 0 ? path : path.Substring(ci, 5)));
            for (int type = 0; type < 3; type++)
            {
                var bb = new byte[CapSize * 64]; ushort n = 64;
                if (HidP_GetButtonCaps(type, bb, ref n, pp) >= 0)
                    for (int k = 0; k < n; k++)
                    {
                        int o = k * CapSize;
                        bool range = bb[o + 12] != 0; // IsRange
                        sb.AppendLine(string.Format("  {0,-7} BUTTON  page=0x{1:X4} reportId={2} usage={3}", Types[type], U16(bb, o), bb[o + 2],
                            range ? string.Format("0x{0:X2}..0x{1:X2}", U16(bb, o + 56), U16(bb, o + 58)) : string.Format("0x{0:X2}", U16(bb, o + 56))));
                    }
                var vb = new byte[CapSize * 64]; n = 64;
                if (HidP_GetValueCaps(type, vb, ref n, pp) >= 0)
                    for (int k = 0; k < n; k++)
                    {
                        int o = k * CapSize;
                        bool range = vb[o + 12] != 0;
                        sb.AppendLine(string.Format("  {0,-7} VALUE   page=0x{1:X4} reportId={2} usage={3} bits={4} count={5} logical={6}..{7}", Types[type], U16(vb, o), vb[o + 2],
                            range ? string.Format("0x{0:X2}..0x{1:X2}", U16(vb, o + 56), U16(vb, o + 58)) : string.Format("0x{0:X2}", U16(vb, o + 56)),
                            U16(vb, o + 18), U16(vb, o + 20), I32(vb, o + 40), I32(vb, o + 44)));
                    }
            }
        });
        return sb.ToString();
    }

    // Lets the Windows HID API build the output report that has exactly this usage set. Use this instead of guessing
    // bit positions from the order of usages: the order in the caps list is the REVERSE of the bit order here.
    public static string BuildOutput(string match, string col, byte reportId, ushort page, ushort usage)
    {
        string result = "not found";
        ForEachCollection(match, col, (path, h, pp) =>
        {
            HIDP_CAPS caps;
            if (HidP_GetCaps(pp, out caps) < 0) { result = "HidP_GetCaps failed"; return; }
            var rep = new byte[caps.OutputReportByteLength];
            int s1 = HidP_InitializeReportForID(1, reportId, pp, rep, rep.Length); // 1 = HidP_Output
            int n = 1;
            int s2 = HidP_SetUsages(1, page, 0, new ushort[] { usage }, ref n, pp, rep, rep.Length);
            result = string.Format("{0}: page=0x{1:X4} usage=0x{2:X2} -> report [{3}] (init=0x{4:X}, set=0x{5:X}; 0x110000 = success)",
                col, page, usage, BitConverter.ToString(rep).Replace("-", ","), s1, s2);
        });
        return result;
    }
}
