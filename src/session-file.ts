import { chmod, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";

export interface PersistedSession {
  access_token: string;
  refresh_token: string;
}

/**
 * Atomically write the session JSON with 0600 perms in a 0700 dir.
 *
 * Hardened:
 * - Tightens the parent dir to 0700 even if it pre-existed under a loose umask
 *   (mkdir({mode}) is a no-op on existing dirs).
 * - Unique .tmp suffix per write so concurrent writers don't truncate each other.
 * - fdatasync before rename so a power loss between rotation and rename can't
 *   silently lose a freshly-rotated refresh token.
 * - try/finally unlinks the .tmp on any rename failure so cleartext tokens
 *   don't leak in an orphan file.
 */
export async function writeSessionFile(path: string, data: PersistedSession): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // POSIX-only — Windows ignores. Tightens pre-existing dirs.
  await chmod(dir, 0o700).catch(() => undefined);

  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(data));
      // Flush data+metadata to physical disk before publishing the rename.
      await handle.datasync().catch(() => undefined);
    } finally {
      await handle.close();
    }
    // Belt-and-braces: ensure mode is 0600 even if umask interfered.
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, path);
    renamed = true;
  } finally {
    if (!renamed) {
      await unlink(tmp).catch(() => undefined);
    }
  }
}

/**
 * Read & parse the session file. Returns null on ENOENT or parse failure.
 * Self-heals corrupt files: a parse/shape failure unlinks the bad file so the
 * next login doesn't trip on the same garbage forever.
 */
export async function readSessionFile(path: string): Promise<PersistedSession | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSession>;
    if (typeof parsed.access_token === "string" && typeof parsed.refresh_token === "string") {
      return { access_token: parsed.access_token, refresh_token: parsed.refresh_token };
    }
  } catch {
    // fall through to self-heal
  }
  console.error(`[truecalling-mcp] session file at ${path} is corrupt — removing to self-heal`);
  await deleteSessionFile(path);
  return null;
}

/**
 * Best-effort delete of the session file AND any orphan .tmp siblings from
 * failed atomic writes. Swallows ENOENT.
 */
export async function deleteSessionFile(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
  // Sweep any leftover .tmp variants the rename failed to clean up.
  const dir = dirname(path);
  const stem = basename(path);
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (entry.startsWith(`${stem}.`) && entry.endsWith(".tmp")) {
      await unlink(`${dir}/${entry}`).catch(() => undefined);
    }
  }
}
