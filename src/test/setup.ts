import { beforeEach } from 'vitest';

/** In-memory Web Storage for the node test environment. */
class MemoryStorage implements Storage {
  private items = new Map<string, string>();

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.items.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  configurable: true,
  writable: true,
});

beforeEach(async () => {
  localStorage.clear();
  // Imported lazily: a static import here would load secureStorage (and the
  // real tauri-api) before a test file's vi.mock() could replace it.
  const { resetSecureStorageCache } = await import('@/lib/secureStorage');
  resetSecureStorageCache();
});
