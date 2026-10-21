import { vi } from 'vitest';

/**
 * Fake backend for tests that need the desktop code paths: an in-memory OS
 * keychain plus per-command handlers. Use with
 * `vi.mock('@/lib/tauri-api', () => desktopTauriApi())`.
 */
export const keychain = new Map<string, string>();
export const commandHandlers = new Map<string, (args: Record<string, unknown>) => unknown>();

export const fakeInvoke = vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
  switch (command) {
    case 'secret_get':
      return keychain.get(args.key as string) ?? null;
    case 'secret_set':
      keychain.set(args.key as string, args.value as string);
      return null;
    case 'secret_delete':
      keychain.delete(args.key as string);
      return null;
    default: {
      const handler = commandHandlers.get(command);
      if (!handler) throw new Error(`unexpected command ${command}`);
      return handler(args);
    }
  }
});

export async function desktopTauriApi() {
  const actual = await vi.importActual<typeof import('@/lib/tauri-api')>('@/lib/tauri-api');
  return { ...actual, isTauriAvailable: () => true, invoke: fakeInvoke };
}

export function resetDesktop(): void {
  keychain.clear();
  commandHandlers.clear();
  fakeInvoke.mockClear();
}
