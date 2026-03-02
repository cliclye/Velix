/// <reference types="vite/client" />

interface VelixDirEntry {
  name: string;
  isDirectory: boolean;
  isFile?: boolean;
  isSymlink?: boolean;
}

interface VelixNotificationPayload {
  title: string;
  body?: string;
}

interface VelixElectronBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen(eventName: string, callback: (payload: unknown) => void): () => void;
  readDir(path: string): Promise<VelixDirEntry[]>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
  openDirectory(): Promise<string | null>;
  isNotificationPermissionGranted(): Promise<boolean>;
  requestNotificationPermission(): Promise<"granted" | "denied" | "default">;
  sendNotification(payload: VelixNotificationPayload): Promise<void>;
}

interface Window {
  __VELIX_ELECTRON__?: VelixElectronBridge;
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
}
