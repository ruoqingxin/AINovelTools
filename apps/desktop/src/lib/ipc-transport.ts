import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type EventCallback, type Options } from "@tauri-apps/api/event";
import type { IpcEvents, IpcRequests, IpcResponses } from "./ipc-types.generated";

type CommandArgs<C extends keyof IpcRequests> = keyof IpcRequests[C] extends never
  ? [args?: undefined]
  : [args: NoInfer<IpcRequests[C]>];

const pendingCommands = new Set<Promise<unknown>>();

export function invoke<C extends keyof IpcRequests>(command: C, ...args: CommandArgs<C>): Promise<IpcResponses[C]> {
  const request: Promise<IpcResponses[C]> = args.length ? tauriInvoke(command, args[0]) : tauriInvoke(command);
  pendingCommands.add(request);
  void request.then(() => pendingCommands.delete(request), () => pendingCommands.delete(request));
  return request;
}

export async function waitForPendingCommands() {
  // Query cancellation cannot cancel native IPC or a chained save/commit request.
  while (pendingCommands.size) await Promise.allSettled([...pendingCommands]);
}

export function listen<E extends keyof IpcEvents>(event: E, handler: EventCallback<IpcEvents[E]>, options?: Options) {
  return tauriListen(event, handler, options);
}
