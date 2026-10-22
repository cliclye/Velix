export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile?: boolean;
  isSymlink?: boolean;
}

export type UnlistenFn = () => void;

export type NotificationPermissionState = "granted" | "denied" | "default";

export interface NotificationPayload {
  title: string;
  body?: string;
}

interface PlatformEvent<T> {
  payload: T;
}

interface OpenDialogOptions {
  directory?: boolean;
  multiple?: boolean;
}

type RuntimeTarget = "tauri" | "web";

const isTauriRuntime = () =>
  typeof window !== "undefined" &&
  (Boolean(window.__TAURI__) || Boolean(window.__TAURI_INTERNALS__));

export const getRuntimeTarget = (): RuntimeTarget => {
  if (isTauriRuntime()) return "tauri";
  return "web";
};

const unsupportedRuntime = (apiName: string): never => {
  throw new Error(
    `${apiName} is not available in runtime "${getRuntimeTarget()}". ` +
      `Run the Velix desktop app (Tauri).`,
  );
};

let tauriCoreModule: Promise<typeof import("@tauri-apps/api/core")> | null = null;
let tauriEventModule: Promise<typeof import("@tauri-apps/api/event")> | null = null;
let tauriFsModule: Promise<typeof import("@tauri-apps/plugin-fs")> | null = null;
let tauriDialogModule: Promise<typeof import("@tauri-apps/plugin-dialog")> | null =
  null;
let tauriNotificationModule: Promise<
  typeof import("@tauri-apps/plugin-notification")
> | null = null;

const tauriCore = () => (tauriCoreModule ??= import("@tauri-apps/api/core"));
const tauriEvent = () => (tauriEventModule ??= import("@tauri-apps/api/event"));
const tauriFs = () => (tauriFsModule ??= import("@tauri-apps/plugin-fs"));
const tauriDialog = () =>
  (tauriDialogModule ??= import("@tauri-apps/plugin-dialog"));
const tauriNotification = () =>
  (tauriNotificationModule ??= import("@tauri-apps/plugin-notification"));

export async function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isTauriRuntime()) {
    const { invoke: tauriInvoke } = await tauriCore();
    return tauriInvoke<T>(command, args);
  }
  return unsupportedRuntime(`invoke("${command}")`);
}

export async function listen<T>(
  eventName: string,
  handler: (event: PlatformEvent<T>) => void,
): Promise<UnlistenFn> {
  if (isTauriRuntime()) {
    const { listen: tauriListen } = await tauriEvent();
    return tauriListen<T>(eventName, handler);
  }
  return unsupportedRuntime(`listen("${eventName}")`);
}

export async function readDir(path: string): Promise<DirEntry[]> {
  if (isTauriRuntime()) {
    const { readDir: tauriReadDir } = await tauriFs();
    return tauriReadDir(path);
  }
  return unsupportedRuntime("readDir");
}

export async function readTextFile(path: string): Promise<string> {
  if (isTauriRuntime()) {
    const { readTextFile: tauriReadTextFile } = await tauriFs();
    return tauriReadTextFile(path);
  }
  return unsupportedRuntime("readTextFile");
}

export async function writeBinaryFile(
  path: string,
  data: Uint8Array,
): Promise<void> {
  if (isTauriRuntime()) {
    const { writeFile } = await tauriFs();
    return writeFile(path, data);
  }
  return unsupportedRuntime("writeBinaryFile");
}

export async function writeTextFile(
  path: string,
  contents: string,
): Promise<void> {
  if (isTauriRuntime()) {
    const { writeTextFile: tauriWriteTextFile } = await tauriFs();
    return tauriWriteTextFile(path, contents);
  }
  return unsupportedRuntime("writeTextFile");
}

export async function mkdir(
  path: string,
  options?: { recursive?: boolean },
): Promise<void> {
  if (isTauriRuntime()) {
    const { mkdir: tauriMkdir } = await tauriFs();
    return tauriMkdir(path, options);
  }
  return unsupportedRuntime("mkdir");
}

export async function remove(path: string): Promise<void> {
  if (isTauriRuntime()) {
    const { remove: tauriRemove } = await tauriFs();
    return tauriRemove(path);
  }
  return unsupportedRuntime("remove");
}

export async function open(
  options: OpenDialogOptions,
): Promise<string | string[] | null> {
  if (isTauriRuntime()) {
    const { open: tauriOpen } = await tauriDialog();
    return tauriOpen(options);
  }
  return unsupportedRuntime("open dialog");
}

export async function isPermissionGranted(): Promise<boolean> {
  if (isTauriRuntime()) {
    const notification = await tauriNotification();
    return notification.isPermissionGranted();
  }
  return false;
}

export async function requestPermission(): Promise<NotificationPermissionState> {
  if (isTauriRuntime()) {
    const notification = await tauriNotification();
    return notification.requestPermission();
  }
  return "denied";
}

export async function sendNotification(
  payload: NotificationPayload,
): Promise<void> {
  if (isTauriRuntime()) {
    const notification = await tauriNotification();
    return notification.sendNotification(payload);
  }
}
