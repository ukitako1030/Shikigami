using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace ShikigamiWindows {
  internal static class Program {
    internal static readonly string ProductRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Shikigami");
    internal static readonly string AppRoot = Path.Combine(ProductRoot, "app");
    internal static readonly string DataRoot = Path.Combine(ProductRoot, "data");
    internal static readonly string Shortcut = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Shikigami.lnk");
    internal const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Shikigami";

    [STAThread]
    private static void Main(string[] args) {
      Application.EnableVisualStyles();
      Application.SetCompatibleTextRenderingDefault(false);
      // Only the copy inside the install folder launches the app. Anything else (an extracted ZIP, or the exe
      // opened straight from inside the ZIP) shows the installer, which explains how to extract when needed.
      string mode = args.Length == 0 ? (IsInstalledCopy() ? "--launch" : "--install") : args[0];
      try {
        if (mode == "--launch") { Launch(); return; }
        if (mode == "--silent") { InstallPayload(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app")); return; }
        if (mode == "--uninstall-now") { UninstallNow(); return; }
        if (mode == "--uninstall") { ConfirmUninstall(); return; }
        if (mode != "--install") throw new InvalidOperationException("起動引数を認識できませんでした。");
        Application.Run(new InstallerForm());
      } catch (Exception error) {
        Environment.ExitCode = 1;
        if (mode == "--silent") {
          File.WriteAllText(Path.Combine(Path.GetTempPath(), "Shikigami-install-error.txt"), error.ToString());
        } else {
          MessageBox.Show(error.Message, "Shikigami", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
      }
    }

    internal static void Launch() {
      string node = Path.Combine(AppRoot, "node.exe");
      string script = Path.Combine(AppRoot, "src", "desktop-launcher.mjs");
      if (!File.Exists(node) || !File.Exists(script)) throw new FileNotFoundException("アプリのファイルが見つかりません。再インストールしてください。");
      Directory.CreateDirectory(DataRoot);
      ProcessStartInfo start = new ProcessStartInfo(node, Quote(script));
      start.WorkingDirectory = AppRoot;
      start.UseShellExecute = false;
      start.CreateNoWindow = true;
      start.WindowStyle = ProcessWindowStyle.Hidden;
      start.RedirectStandardError = true;
      start.EnvironmentVariables["SHIKIGAMI_DATA_DIR"] = DataRoot;
      Process process = Process.Start(start);
      if (process == null) throw new InvalidOperationException("Shikigami を起動できませんでした。");
      if (process.WaitForExit(20000) && process.ExitCode != 0) {
        string detail = process.StandardError.ReadToEnd().Trim();
        throw new InvalidOperationException("起動できませんでした。\n\n" + (detail.Length == 0 ? "Google Chrome とアプリのファイルを確認してください。" : detail));
      }
      process.Dispose();
    }

    internal static bool IsInstalledCopy() {
      string here = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd('\\');
      return String.Equals(here, Path.GetFullPath(AppRoot).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
    }
    internal const string InUseMessage = "Shikigami のファイルが使用中です。Shikigami と、Shikigami を使っている Codex を終了してから、もう一度お試しください。";
    // Renaming the folder fails while any program inside it (for example node.exe started by Codex) is running.
    // Checking this first means an update or uninstall either completes or leaves the old version untouched.
    internal static string MoveAside(string folder, string label) {
      string aside = folder + "." + label + "-" + Guid.NewGuid().ToString("N");
      try { Directory.Move(folder, aside); }
      catch (IOException) { throw new IOException(InUseMessage); }
      catch (UnauthorizedAccessException) { throw new IOException(InUseMessage); }
      return aside;
    }
    internal static void DeleteQuietly(string folder) {
      try { if (Directory.Exists(folder)) Directory.Delete(folder, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
    internal static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    internal static void CheckSafeTree(string root) {
      if (!Directory.Exists(root)) return;
      if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0) throw new IOException("リンクを含むインストール先は操作できません。");
      foreach (string entry in Directory.GetFileSystemEntries(root)) {
        FileAttributes attributes = File.GetAttributes(entry);
        if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("リンクを含むインストール先は操作できません。");
        if ((attributes & FileAttributes.Directory) != 0) CheckSafeTree(entry);
      }
    }
    internal static void VerifyInstallRoot() {
      string expected = Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Shikigami", "app"));
      if (!String.Equals(Path.GetFullPath(AppRoot), expected, StringComparison.OrdinalIgnoreCase)) throw new IOException("インストール先の確認に失敗しました。");
      if (Directory.Exists(ProductRoot) && (File.GetAttributes(ProductRoot) & FileAttributes.ReparsePoint) != 0) throw new IOException("リンクを含むインストール先は操作できません。");
      CheckSafeTree(AppRoot);
    }
    internal static void CopyTree(string source, string destination) {
      if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0) throw new IOException("配布物にリンクを含めることはできません。");
      Directory.CreateDirectory(destination);
      foreach (string file in Directory.GetFiles(source)) {
        if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException("配布物にリンクを含めることはできません。");
        File.Copy(file, Path.Combine(destination, Path.GetFileName(file)), true);
      }
      foreach (string folder in Directory.GetDirectories(source)) CopyTree(folder, Path.Combine(destination, Path.GetFileName(folder)));
    }
    internal static void InstallPayload(string payload) {
      if (!File.Exists(Path.Combine(payload, "node.exe")) || !File.Exists(Path.Combine(payload, "src", "desktop-launcher.mjs"))) throw new FileNotFoundException("配布物が見つかりません。ZIPをすべて展開してください。");
      VerifyInstallRoot();
      RequestServiceShutdown();
      Directory.CreateDirectory(ProductRoot);
      Directory.CreateDirectory(DataRoot);
      // Copy the new version beside the old one first, then swap folders, so a failure never mixes versions.
      string staging = AppRoot + ".new-" + Guid.NewGuid().ToString("N");
      string previous = null;
      try {
        CopyTree(payload, staging);
        File.Copy(Application.ExecutablePath, Path.Combine(staging, "Shikigami.exe"), true);
        if (Directory.Exists(AppRoot)) previous = MoveAside(AppRoot, "old");
        Directory.Move(staging, AppRoot);
      } catch {
        if (previous != null && !Directory.Exists(AppRoot)) Directory.Move(previous, AppRoot);
        DeleteQuietly(staging);
        throw;
      }
      if (previous != null) DeleteQuietly(previous);
      CreateShortcut();
      RegisterUninstall();
    }
    internal static void RequestServiceShutdown() {
      string sessionFile = Path.Combine(DataRoot, "session.json");
      if (!File.Exists(sessionFile)) return;
      string text = File.ReadAllText(sessionFile);
      Match baseMatch = Regex.Match(text, "\\\"base\\\"\\s*:\\s*\\\"(http://127\\.0\\.0\\.1:[0-9]+)\\\"");
      Match tokenMatch = Regex.Match(text, "\\\"token\\\"\\s*:\\s*\\\"([a-f0-9]{48})\\\"");
      Match pidMatch = Regex.Match(text, "\\\"pid\\\"\\s*:\\s*([0-9]+)");
      if (!baseMatch.Success || !tokenMatch.Success) return;
      try {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(baseMatch.Groups[1].Value + "/api/shutdown");
        request.Method = "POST";
        request.Timeout = 3000;
        request.Headers["X-Shikigami-Token"] = tokenMatch.Groups[1].Value;
        request.ContentLength = 0;
        using (WebResponse response = request.GetResponse()) { }
        int pid;
        if (pidMatch.Success && Int32.TryParse(pidMatch.Groups[1].Value, out pid)) {
          try { using (Process process = Process.GetProcessById(pid)) process.WaitForExit(5000); }
          catch (ArgumentException) { }
        }
      } catch (WebException) { /* The recorded service may already have ended. */ }
    }
    internal static void CreateShortcut() {
      Type shellType = Type.GetTypeFromProgID("WScript.Shell");
      if (shellType == null) throw new InvalidOperationException("スタートメニューのショートカットを作成できませんでした。");
      object shell = Activator.CreateInstance(shellType);
      object shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { Shortcut });
      Type linkType = shortcut.GetType();
      linkType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { Path.Combine(AppRoot, "Shikigami.exe") });
      linkType.InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut, new object[] { "--launch" });
      linkType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { AppRoot });
      linkType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "AI専用のブラウザ作業空間" });
      linkType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
    }
    internal static void RegisterUninstall() {
      using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallKey)) {
        key.SetValue("DisplayName", "Shikigami");
        key.SetValue("DisplayVersion", "0.1.0");
        key.SetValue("Publisher", "Shikigami contributors");
        key.SetValue("InstallLocation", AppRoot);
        key.SetValue("UninstallString", Quote(Path.Combine(AppRoot, "Shikigami.exe")) + " --uninstall");
        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
      }
    }
    private static void ConfirmUninstall() {
      DialogResult answer = MessageBox.Show("Shikigami を削除しますか？\n\n保存した作業データは残します。", "Shikigami のアンインストール", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
      if (answer != DialogResult.Yes) return;
      VerifyInstallRoot();
      string temporary = Path.Combine(Path.GetTempPath(), "Shikigami-uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
      File.Copy(Application.ExecutablePath, temporary);
      ProcessStartInfo start = new ProcessStartInfo(temporary, "--uninstall-now");
      start.UseShellExecute = false;
      start.CreateNoWindow = true;
      start.WindowStyle = ProcessWindowStyle.Hidden;
      if (Process.Start(start) == null) throw new IOException("アンインストーラーを起動できませんでした。");
    }
    private static void UninstallNow() {
      try {
        VerifyInstallRoot();
        RequestServiceShutdown();
        string removing = Directory.Exists(AppRoot) ? MoveAside(AppRoot, "removing") : null;
        if (File.Exists(Shortcut)) File.Delete(Shortcut);
        Registry.CurrentUser.DeleteSubKey(UninstallKey, false);
        if (removing != null) DeleteQuietly(removing);
        MessageBox.Show("Shikigami を削除しました。\n作業データは次の場所に残しています。\n" + DataRoot + "\n\nCodex に追加した接続設定は残っています。不要な場合は Codex の設定ファイル（通常は " + Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex", "config.toml") + "）から [mcp_servers.shikigami] の項目を削除してください。", "Shikigami", MessageBoxButtons.OK, MessageBoxIcon.Information);
      } catch (Exception error) {
        MessageBox.Show("削除できませんでした。\n\n" + error.Message, "Shikigami", MessageBoxButtons.OK, MessageBoxIcon.Error);
      } finally {
        string self = Application.ExecutablePath;
        if (self.StartsWith(Path.GetTempPath(), StringComparison.OrdinalIgnoreCase)) {
          // The temporary uninstaller cannot delete itself while running; ask cmd to remove it shortly after exit.
          ProcessStartInfo cleanup = new ProcessStartInfo("cmd.exe", "/d /c ping -n 3 127.0.0.1 >nul & del /f /q " + Quote(self));
          cleanup.UseShellExecute = false;
          cleanup.CreateNoWindow = true;
          try { Process.Start(cleanup); } catch (Win32Exception) { }
        }
      }
    }
  }

  internal sealed class InstallerForm : Form {
    private readonly Label title, subtitle, detail, note;
    private readonly Button action;
    private readonly ProgressBar progress;
    private readonly Image brandImage;
    private bool completed;
    internal InstallerForm() {
      Text = "Shikigami セットアップ";
      ClientSize = new Size(610, 390);
      MinimumSize = new Size(610, 390);
      MaximumSize = new Size(610, 390);
      StartPosition = FormStartPosition.CenterScreen;
      FormBorderStyle = FormBorderStyle.FixedDialog;
      MaximizeBox = false;
      BackColor = Color.FromArgb(246, 249, 247);
      Font = new Font("Yu Gothic UI", 10, FontStyle.Regular);
      DoubleBuffered = true;
      using (Stream imageStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("ShikigamiSpirit.png")) {
        if (imageStream != null) using (Image raw = Image.FromStream(imageStream)) brandImage = new Bitmap(raw);
      }
      title = LabelAt("AIの作業に、専用の場所を。", 42, 35, 530, 45, 23, FontStyle.Bold, Color.White);
      subtitle = LabelAt("Shikigami · Windows セットアップ", 44, 86, 520, 25, 10, FontStyle.Regular, Color.FromArgb(204, 234, 224));
      detail = LabelAt("人の作業を邪魔しない、AI専用ブラウザを準備します。", 43, 185, 530, 65, 13, FontStyle.Regular, Color.FromArgb(24, 53, 47));
      note = LabelAt("管理者権限は不要です。アプリとデータは別々に保存します。", 43, 256, 530, 30, 9, FontStyle.Regular, Color.FromArgb(96, 115, 109));
      progress = new ProgressBar { Left = 43, Top = 294, Width = 524, Height = 5, Style = ProgressBarStyle.Marquee, Visible = false };
      action = new Button { Left = 387, Top = 323, Width = 180, Height = 42, Text = "インストールする", FlatStyle = FlatStyle.Flat, ForeColor = Color.White, BackColor = Color.FromArgb(24, 112, 88), Cursor = Cursors.Hand };
      action.FlatAppearance.BorderSize = 0;
      action.Click += OnAction;
      Controls.AddRange(new Control[] { title, subtitle, detail, note, progress, action });
    }
    private Label LabelAt(string value, int x, int y, int w, int h, int size, FontStyle style, Color color) {
      return new Label { Text = value, Left = x, Top = y, Width = w, Height = h, ForeColor = color, BackColor = Color.Transparent, Font = new Font("Yu Gothic UI", size, style), AutoEllipsis = true };
    }
    protected override void OnPaint(PaintEventArgs e) {
      base.OnPaint(e);
      using (System.Drawing.Drawing2D.LinearGradientBrush brush = new System.Drawing.Drawing2D.LinearGradientBrush(new Rectangle(0, 0, Width, 142), Color.FromArgb(15, 57, 54), Color.FromArgb(27, 104, 81), 0f)) {
        e.Graphics.FillRectangle(brush, 0, 0, Width, 142);
      }
      if (brandImage != null) e.Graphics.DrawImage(brandImage, new Rectangle(473, 5, 130, 130));
      using (Pen pen = new Pen(Color.FromArgb(218, 229, 223))) e.Graphics.DrawLine(pen, 43, 313, 567, 313);
    }
    protected override void OnFormClosed(FormClosedEventArgs e) {
      if (brandImage != null) brandImage.Dispose();
      base.OnFormClosed(e);
    }
    private void OnAction(object sender, EventArgs e) {
      if (completed) { Program.Launch(); Close(); return; }
      string payload = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app");
      if (!File.Exists(Path.Combine(payload, "node.exe")) || !File.Exists(Path.Combine(payload, "src", "desktop-launcher.mjs"))) {
        MessageBox.Show("配布物が見つかりません。ZIPをすべて展開してから実行してください。", "Shikigami", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return;
      }
      action.Enabled = false;
      progress.Visible = true;
      detail.Text = "インストールしています…";
      BackgroundWorker worker = new BackgroundWorker();
      worker.DoWork += (s, a) => Program.InstallPayload(payload);
      worker.RunWorkerCompleted += (s, a) => {
        progress.Visible = false;
        action.Enabled = true;
        if (a.Error != null) {
          detail.Text = "インストールできませんでした。";
          note.Text = "以前のバージョンはそのまま残っています。";
          MessageBox.Show(a.Error.Message, "Shikigami", MessageBoxButtons.OK, MessageBoxIcon.Error);
          return;
        }
        completed = true;
        detail.Text = "準備ができました。\nスタートメニューからいつでも開けます。";
        note.Text = "AIのブラウザと操作画面は、それぞれ専用の環境で動きます。";
        action.Text = "Shikigami を開く";
      };
      worker.RunWorkerAsync();
    }
  }
}
