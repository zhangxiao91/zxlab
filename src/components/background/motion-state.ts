export type VisualPhase =
  | "intro-idle"
  | "intro-hover"
  | "intro-hit"
  | "intro-transition"
  | "hero-idle"
  | "scrolling";

export interface MotionState {
  phase: VisualPhase;
  intensity: number;
  direction: -1 | 0 | 1;
  velocity: number;
  patternSpeed: number;
  meteorIntensity: number;
  glitchIntensity: number;
}

export const motionStateEvent = "zxlab:motion-state";

const defaultState: MotionState = {
  phase: "hero-idle",
  intensity: 0,
  direction: 0,
  velocity: 0,
  patternSpeed: 1,
  meteorIntensity: 0,
  glitchIntensity: 0,
};

type MotionController = {
  state: MotionState;
  update: (patch: Partial<MotionState>) => MotionState;
};

declare global {
  interface Window {
    __zxMotionController?: MotionController;
  }
}

function applyMotionProperties(state: MotionState) {
  const root = document.documentElement;
  root.dataset.visualPhase = state.phase;
  root.style.setProperty("--motion-intensity", state.intensity.toFixed(3));
  root.style.setProperty("--motion-direction", String(state.direction));
  root.style.setProperty("--pattern-speed", state.patternSpeed.toFixed(3));
  root.style.setProperty("--meteor-intensity", state.meteorIntensity.toFixed(3));
  root.style.setProperty("--glitch-intensity", state.glitchIntensity.toFixed(3));
}

export function getMotionController(): MotionController {
  if (window.__zxMotionController) return window.__zxMotionController;

  const state: MotionState = {
    ...defaultState,
    phase: document.documentElement.classList.contains("welcome-pending") ? "intro-idle" : "hero-idle",
    patternSpeed: document.documentElement.classList.contains("welcome-pending") ? 0.28 : 1,
  };

  const controller: MotionController = {
    state,
    update(patch) {
      Object.assign(state, patch);
      applyMotionProperties(state);
      window.dispatchEvent(new CustomEvent<MotionState>(motionStateEvent, { detail: { ...state } }));
      return state;
    },
  };

  window.__zxMotionController = controller;
  applyMotionProperties(state);
  return controller;
}
