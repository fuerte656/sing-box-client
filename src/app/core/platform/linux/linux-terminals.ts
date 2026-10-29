import { ExecResult } from '../core-platform';

/** Builds the command that opens a terminal running `shellCommand` (already quoted for sh). */
type TerminalFactory = (shellCommand: string) => string;

/** Terminal emulators tried in order, by program name. */
const TERMINALS = new Map<string, TerminalFactory>([
  ['x-terminal-emulator', (cmd) => `x-terminal-emulator -e sh -c ${cmd}`],
  ['gnome-terminal', (cmd) => `gnome-terminal -- sh -c ${cmd}`],
  ['konsole', (cmd) => `konsole -e sh -c ${cmd}`],
  ['xfce4-terminal', (cmd) => `xfce4-terminal -x sh -c ${cmd}`],
  ['kitty', (cmd) => `kitty sh -c ${cmd}`],
  ['alacritty', (cmd) => `alacritty -e sh -c ${cmd}`],
  ['xterm', (cmd) => `xterm -e sh -c ${cmd}`],
]);

/** Opens `shellCommand` in the first installed terminal emulator, detached from the app. */
export async function launchTerminal(
  exec: (command: string) => Promise<ExecResult>,
  shellCommand: string,
): Promise<void> {
  for (const [program, terminal] of TERMINALS) {
    if ((await exec(`command -v ${program}`)).exitCode !== 0) continue;
    const result = await exec(`nohup ${terminal(shellCommand)} >/dev/null 2>&1 &`);
    if (result.exitCode === 0) return;
  }
  throw new Error(`No terminal emulator found (tried ${[...TERMINALS.keys()].join(', ')})`);
}
