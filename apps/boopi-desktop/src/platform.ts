import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type PetSize = "small" | "medium" | "large";

export interface PetPreferences {
  quiet: boolean;
  size: PetSize;
  launchAtLogin: boolean;
  x?: number;
  y?: number;
}

export async function getPreferences(): Promise<PetPreferences> {
  return invoke<PetPreferences>("get_preferences");
}

export async function startPetDrag(): Promise<void> {
  await invoke("start_pet_drag");
}

export async function saveCurrentPosition(): Promise<void> {
  await invoke("save_current_position");
}

export async function listenForPreferences(
  handler: (preferences: PetPreferences) => void,
): Promise<UnlistenFn> {
  return listen<PetPreferences>("preferences-changed", (event) => handler(event.payload));
}

export async function listenForAppErrors(
  handler: (message: string) => void,
): Promise<UnlistenFn> {
  return listen<string>("boopi-error", (event) => handler(event.payload));
}
