import { useCallback, useEffect, useRef, useState } from 'react';
import { check, Update } from '@tauri-apps/plugin-updater';

interface AppUpdateState {
  checking: boolean;
  updateAvailable: boolean;
  version: string | null;
  notes: string | null;
  downloading: boolean;
  error: string | null;
}

export function useAppUpdate() {
  const updateRef = useRef<Update | null>(null);
  const [state, setState] = useState<AppUpdateState>({
    checking: false,
    updateAvailable: false,
    version: null,
    notes: null,
    downloading: false,
    error: null,
  });

  const checkForUpdates = useCallback(async () => {
    setState(prev => ({ ...prev, checking: true, error: null }));
    try {
      const result = await check();
      updateRef.current = result;
      if (result) {
        setState({
          checking: false,
          updateAvailable: true,
          version: result.version,
          notes: result.body ?? null,
          downloading: false,
          error: null,
        });
      } else {
        setState({
          checking: false,
          updateAvailable: false,
          version: null,
          notes: null,
          downloading: false,
          error: null,
        });
      }
    } catch (err) {
      setState(prev => ({
        ...prev,
        checking: false,
        error: err instanceof Error ? err.message : 'Failed to check for updates',
      }));
    }
  }, []);

  const install = useCallback(async () => {
    const currentUpdate = updateRef.current;
    if (!currentUpdate) return;
    setState(prev => ({ ...prev, downloading: true, error: null }));
    try {
      await currentUpdate.downloadAndInstall();
    } catch (err) {
      setState(prev => ({
        ...prev,
        downloading: false,
        error: err instanceof Error ? err.message : 'Failed to install update',
      }));
    }
  }, []);

  return { ...state, checkForUpdates, install };
}
