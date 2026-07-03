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
  messageStepInterval: number;
}

export const welcomeGateConfig: Readonly<WelcomeGateConfig> = Object.freeze({
  enabled: true,
  storageKey: "zxlab-welcome-seen:v1",
  welcomeText: "welcome to zxlab!",
  enterLabel: "Enter ZXLab",
  replayQueryKey: "replay-welcome",
  hitDuration: 980,
  leaveDuration: 1180,
  failsafeDuration: 4000,
  messageSteps: ["wel", "welcome", "welcome to", "welcome to zxlab!"],
  messageStepInterval: 175,
});

export const welcomeFinishedEvent = "zxlab:welcome-finished";
