import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Cross-platform path to the persisted Supabase session JSON.
 *
 * macOS:   ~/Library/Application Support/truecalling-mcp/session.json
 * Linux:   $XDG_STATE_HOME/truecalling-mcp/session.json
 *          (fallback ~/.local/state/truecalling-mcp/session.json)
 * Windows: %LOCALAPPDATA%\truecalling-mcp\session.json
 *
 * Pure function — performs no I/O.
 */
export function sessionFilePath(): string {
  const app = "truecalling-mcp";
  const plat = platform();
  if (plat === "darwin") {
    return join(homedir(), "Library", "Application Support", app, "session.json");
  }
  if (plat === "win32") {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(base, app, "session.json");
  }
  // linux / *bsd
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(base, app, "session.json");
}
