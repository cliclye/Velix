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

type RuntimeTarget = "tauri" | "electron" | "web";

const isElectronRuntime = () =>
  typeof window !== "undefined" && Boolean(window.__VELIX_ELECTRON__);

const isTauriRuntime = () =>
  typeof window !== "undefined" &&
  (Boolean(window.__TAURI__) || Boolean(window.__TAURI_INTERNALS__));

export const getRuntimeTarget = (): RuntimeTarget => {
  if (isElectronRuntime()) return "electron";
  if (isTauriRuntime()) return "tauri";
  return "web";
};

const unsupportedRuntime = (apiName: string): never => {
  throw new Error(
    `${apiName} is not available in runtime "${getRuntimeTarget()}". ` +
      `Use Electron or Tauri desktop runtime.`,
  );
};

const requireElectronApi = (): NonNullable<Window["__VELIX_ELECTRON__"]> => {
  const api = window.__VELIX_ELECTRON__;
  if (!api) {
    throw new Error("Electron bridge is not available.");
  }
  return api;
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
  if (isElectronRuntime()) {
    return requireElectronApi().invoke<T>(command, args);
  }
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
  if (isElectronRuntime()) {
    return requireElectronApi().listen(eventName, (payload) => {
      handler({ payload: payload as T });
    });
  }
  if (isTauriRuntime()) {
    const { listen: tauriListen } = await tauriEvent();
    return tauriListen<T>(eventName, handler);
  }
  return unsupportedRuntime(`listen("${eventName}")`);
}

export async function readDir(path: string): Promise<DirEntry[]> {
  if (isElectronRuntime()) {
    return requireElectronApi().readDir(path);
  }
  if (isTauriRuntime()) {
    const { readDir: tauriReadDir } = await tauriFs();
    return tauriReadDir(path);
  }
  return unsupportedRuntime("readDir");
}

export async function readTextFile(path: string): Promise<string> {
  if (isElectronRuntime()) {
    return requireElectronApi().readTextFile(path);
  }
  if (isTauriRuntime()) {
    const { readTextFile: tauriReadTextFile } = await tauriFs();
    return tauriReadTextFile(path);
  }
  return unsupportedRuntime("readTextFile");
}

export async function writeTextFile(
  path: string,
  contents: string,
): Promise<void> {
  if (isElectronRuntime()) {
    return requireElectronApi().writeTextFile(path, contents);
  }
  if (isTauriRuntime()) {
    const { writeTextFile: tauriWriteTextFile } = await tauriFs();
    return tauriWriteTextFile(path, contents);
  }
  return unsupportedRuntime("writeTextFile");
}

export async function remove(path: string): Promise<void> {
  if (isElectronRuntime()) {
    return requireElectronApi().remove(path);
  }
  if (isTauriRuntime()) {
    const { remove: tauriRemove } = await tauriFs();
    return tauriRemove(path);
  }
  return unsupportedRuntime("remove");
}

export async function open(
  options: OpenDialogOptions,
): Promise<string | string[] | null> {
  if (isElectronRuntime()) {
    if (!options.directory || options.multiple) {
      throw new Error(
        "Electron dialog bridge currently supports directory-only single selection.",
      );
    }
    return requireElectronApi().openDirectory();
  }
  if (isTauriRuntime()) {
    const { open: tauriOpen } = await tauriDialog();
    return tauriOpen(options);
  }
  return unsupportedRuntime("open dialog");
}

export async function isPermissionGranted(): Promise<boolean> {
  if (isElectronRuntime()) {
    return requireElectronApi().isNotificationPermissionGranted();
  }
  if (isTauriRuntime()) {
    const notification = await tauriNotification();
    return notification.isPermissionGranted();
  }
  return false;
}

export async function requestPermission(): Promise<NotificationPermissionState> {
  if (isElectronRuntime()) {
    return requireElectronApi().requestNotificationPermission();
  }
  if (isTauriRuntime()) {
    const notification = await tauriNotification();
    return notification.requestPermission();
  }
  return "denied";
}

export async function sendNotification(
  payload: NotificationPayload,
): Promise<void> {
  if (isElectronRuntime()) {
    return requireElectronApi().sendNotification(payload);
  }
  if (isTauriRuntime()) {
    const notification = await tauriNotification();
    return notification.sendNotification(payload);
  }
}
