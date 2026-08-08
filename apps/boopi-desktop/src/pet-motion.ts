export const CELL_WIDTH = 192;
export const CELL_HEIGHT = 208;

export const PET_STATES = {
  idle: { row: 0, frames: 6, frameMs: 360 },
  runningRight: { row: 1, frames: 8, frameMs: 145 },
  runningLeft: { row: 2, frames: 8, frameMs: 145 },
  waving: { row: 3, frames: 4, frameMs: 320 },
  jumping: { row: 4, frames: 5, frameMs: 240 },
  failed: { row: 5, frames: 8, frameMs: 320 },
  waiting: { row: 6, frames: 6, frameMs: 460 },
  working: { row: 7, frames: 6, frameMs: 460 },
  review: { row: 8, frames: 6, frameMs: 420 },
  looking: { row: 9, frames: 16, frameMs: 320 },
} as const;

export type PetState = keyof typeof PET_STATES;

export interface SpriteCell {
  row: number;
  column: number;
}

export interface PetAction {
  state: PetState;
  message: string;
  weight?: number;
}

export interface PetSequence extends PetAction {
  followUp?: PetAction;
}

export const AMBIENT_ACTIONS: readonly PetAction[] = [
  { state: "waving", message: "Boopi 看见你了。", weight: 3 },
  { state: "waiting", message: "Boopi 在等下一个念头。", weight: 3 },
  { state: "review", message: "Boopi 正在看看桌面。", weight: 2 },
  { state: "looking", message: "Boopi 在四处观察。", weight: 2 },
  { state: "jumping", message: "Boopi 稍微活动了一下。", weight: 1 },
] as const;

export const MANUAL_SEQUENCES: readonly PetSequence[] = [
  {
    state: "working",
    message: "Boopi 正在认真想一想。",
    followUp: { state: "review", message: "Boopi 想完了。" },
  },
  {
    state: "jumping",
    message: "Boopi 发现了一点动静。",
    followUp: { state: "waving", message: "Boopi 想给你看看。" },
  },
  {
    state: "looking",
    message: "Boopi 正在看看周围。",
    followUp: { state: "waiting", message: "Boopi 准备好了。" },
  },
  {
    state: "failed",
    message: "Boopi 刚才走神了。",
    followUp: { state: "waving", message: "Boopi 回来了。" },
  },
] as const;

export function spriteCell(state: PetState, frame: number): SpriteCell {
  if (state !== "looking") {
    return {
      row: PET_STATES[state].row,
      column: Math.max(0, Math.min(frame, PET_STATES[state].frames - 1)),
    };
  }

  const index = ((frame % 16) + 16) % 16;
  return index < 8
    ? { row: 9, column: index }
    : { row: 10, column: index - 8 };
}

export function directionIndex(deltaX: number, deltaY: number): number {
  if (deltaX === 0 && deltaY === 0) return 0;
  const clockwiseFromUp = (Math.atan2(deltaX, -deltaY) * 180) / Math.PI;
  const normalized = (clockwiseFromUp + 360) % 360;
  return Math.round(normalized / 22.5) % 16;
}

export function chooseAmbientAction(
  previous: PetState | undefined,
  randomValue = Math.random(),
): PetAction {
  const candidates = AMBIENT_ACTIONS.filter((action) => action.state !== previous);
  const totalWeight = candidates.reduce((sum, action) => sum + (action.weight ?? 1), 0);
  let cursor = Math.max(0, Math.min(randomValue, 0.999999)) * totalWeight;

  for (const action of candidates) {
    cursor -= action.weight ?? 1;
    if (cursor <= 0) return action;
  }

  return candidates[candidates.length - 1];
}

export function ambientDelay(randomValue = Math.random()): number {
  return 14_000 + Math.max(0, Math.min(randomValue, 1)) * 10_000;
}
