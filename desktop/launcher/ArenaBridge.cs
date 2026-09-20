// Arena Bridge 原生启动器
//
// 为什么需要它：
//   * .cmd 会弹黑框，且中文在 GBK 控制台乱码
//   * .vbs 能静默启动，但图标/属性不像正经软件
//   * 本 exe 是 WinExe 子系统：双击无黑框、有图标，像正常桌面程序
//
// 编译（.NET Framework 自带 csc，无需额外工具）：
//   csc /target:winexe /out:"Arena Bridge.exe" /win32icon:app.ico ArenaBridge.cs
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

static class ArenaBridge
{
    static void Log(string root, string msg)
    {
        try
        {
            string dir = Path.Combine(root, ".arena-bridge");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "launcher.log"),
                DateTime.Now.ToString("s") + "  " + msg + "\r\n");
        }
        catch { }
    }

    [STAThread]
    static void Main(string[] args)
    {
        string here = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        string root = Path.GetFullPath(Path.Combine(here, "..", ".."));

        string exe = Path.Combine(root, "node_modules", "electron", "dist", "electron.exe");
        string app = Path.Combine(root, "desktop", "app");

        Log(root, "launcher started");
        Log(root, "  here = " + here);
        Log(root, "  root = " + root);
        Log(root, "  exe  = " + exe + "  exists=" + File.Exists(exe));
        Log(root, "  app  = " + app + "  exists=" + Directory.Exists(app));

        if (!File.Exists(exe))
        {
            Log(root, "ABORT: electron.exe not found");
            MessageBox.Show("Electron runtime not found:\n" + exe, "Arena Bridge",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        if (!Directory.Exists(app))
        {
            Log(root, "ABORT: app dir not found");
            MessageBox.Show("App folder not found:\n" + app, "Arena Bridge",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = exe;
        psi.Arguments = "\"" + app + "\"";
        psi.WorkingDirectory = root;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;

        // 关键：必须【移除】而不是清空 ELECTRON_RUN_AS_NODE。
        // 赋空字符串在 Electron 看来仍是"已设置"，会退化成纯 Node 模式，
        // 于是 require("electron") 返回 npm 包的路径字符串而非内置模块。
        if (psi.EnvironmentVariables.ContainsKey("ELECTRON_RUN_AS_NODE"))
            psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");

        Log(root, "  cmdline = \"" + exe + "\" \"" + app + "\"");
        Log(root, "  ELECTRON_RUN_AS_NODE removed = " +
            !psi.EnvironmentVariables.ContainsKey("ELECTRON_RUN_AS_NODE"));

        try
        {
            Process p = Process.Start(psi);
            Log(root, "  started pid=" + (p != null ? p.Id.ToString() : "?"));
        }
        catch (Exception ex)
        {
            Log(root, "  START FAILED: " + ex.Message);
            MessageBox.Show("Failed to start:\n" + ex.Message, "Arena Bridge",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
