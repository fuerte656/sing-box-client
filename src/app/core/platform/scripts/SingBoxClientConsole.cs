using System;
using System.Runtime.InteropServices;

public static class SingBoxClientConsole {
  public delegate bool Handler(uint ctrlType);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(Handler handler, bool add);
  [DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint groupId);
  static readonly Handler Ignore = t => true;

  public static int Interrupt(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return 1;
    SetConsoleCtrlHandler(Ignore, true);
    bool sent = GenerateConsoleCtrlEvent(1, 0);
    System.Threading.Thread.Sleep(200);
    FreeConsole();
    return sent ? 0 : 2;
  }
}
