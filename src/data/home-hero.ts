export type MotionState =
  | "boot"
  | "typing"
  | "settling"
  | "holding"
  | "deleting"
  | "switching"
  | "paused";

export const HOME_HERO_WORDS = [
  "BUILDING",
  "OBSERVING",
  "EXPERIMENTING",
  "REMEMBERING",
] as const;

export const HOME_HERO_VIEWBOX_WIDTHS: Record<(typeof HOME_HERO_WORDS)[number], number> = {
  BUILDING: 500,
  OBSERVING: 560,
  EXPERIMENTING: 770,
  REMEMBERING: 660,
};

export const HOME_HERO_TIMING = Object.freeze({
  bootDelay: 420,
  typeIntervals: [72, 64, 82, 58, 76, 68, 86, 62, 74, 66, 80],
  glyphSettleDuration: 430,
  holdDuration: 1520,
  deleteInterval: 16,
  glyphScatterDuration: 145,
  switchGap: 280,
});

export const HOME_HERO_EVENT = "zx:home-hero-motion";
