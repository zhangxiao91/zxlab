export interface WelcomeGateConfig {
  enabled: boolean;
  storageKey: string;
  welcomeText: string;
  enterLabel: string;
  replayQueryKey: string;
  hitDuration: number;
  leaveDuration: number;
  failsafeDuration: number;
  messageSteps: readonly string[];
  messageStepDelays: readonly number[];
  messageStepInterval: number;
}

export const welcomeGateConfig: Readonly<WelcomeGateConfig> = Object.freeze({
  enabled: true,
  storageKey: "zxlab-welcome-seen:v1",
  welcomeText: "welcome to zxlab",
  enterLabel: "Enter ZXLab",
  replayQueryKey: "replay-welcome",
  hitDuration: 520,
  leaveDuration: 930,
  failsafeDuration: 4000,
  messageSteps: ["wel", "welcome", "welcome to", "welcome to zx", "welcome to zxlab"],
  messageStepDelays: [0, 135, 295, 485, 710],
  messageStepInterval: 165,
});

export const welcomeFinishedEvent = "zxlab:welcome-finished";
