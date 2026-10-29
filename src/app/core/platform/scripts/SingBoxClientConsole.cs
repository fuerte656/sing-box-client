using System;
using System.Runtime.InteropServices;

public static class SingBoxClientConsole {
  public delegate bool Handler(uint ctrlType);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(Handler handler, bool add);
  [DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint groupId);
  static readonly Handler Ignore = t => true;

  // Sends CTRL_BREAK to the process group led by pid (sing-box is started as a group leader,
  // see WindowsCorePlatform.coreCommand), never to the whole console: the console can be shared
  // with the app itself, which would exit on the event too.
  public static int Interrupt(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return 1;
    SetConsoleCtrlHandler(Ignore, true);
    bool sent = GenerateConsoleCtrlEvent(1, pid);
    System.Threading.Thread.Sleep(200);
    FreeConsole();
    return sent ? 0 : 2;
  }
}
