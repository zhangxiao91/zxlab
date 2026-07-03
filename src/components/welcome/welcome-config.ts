export interface WelcomeGateConfig {
  enabled: boolean;
  storageKey: string;
  welcomeText: string;
  enterLabel: string;
  replayQueryKey: string;
  hitDuration: number;
  leaveDuration: number;
  failsafeDuration: number;
}

export const welcomeGateConfig: Readonly<WelcomeGateConfig> = Object.freeze({
  enabled: true,
  storageKey: "zxlab-welcome-seen:v1",
  welcomeText: "welcome to zxlab!",
  enterLabel: "Enter ZXLab",
  replayQueryKey: "replay-welcome",
  hitDuration: 360,
  leaveDuration: 950,
  failsafeDuration: 4000,
});

export const welcomeFinishedEvent = "zxlab:welcome-finished";
