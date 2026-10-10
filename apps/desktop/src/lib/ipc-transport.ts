import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type EventCallback, type Options } from "@tauri-apps/api/event";
import type { IpcEvents, IpcRequests, IpcResponses } from "./ipc-types.generated";

type CommandArgs<C extends keyof IpcRequests> = keyof IpcRequests[C] extends never
  ? [args?: undefined]
  : [args: NoInfer<IpcRequests[C]>];

export function invoke<C extends keyof IpcRequests>(command: C, ...args: CommandArgs<C>): Promise<IpcResponses[C]> {
  return args.length ? tauriInvoke(command, args[0]) : tauriInvoke(command);
}

export function listen<E extends keyof IpcEvents>(event: E, handler: EventCallback<IpcEvents[E]>, options?: Options) {
  return tauriListen(event, handler, options);
}
