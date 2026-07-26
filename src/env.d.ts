/// <reference types="astro/client" />

declare module "@strudel/repl/repl-component.mjs";

declare module "@strudel/webaudio" {
  export function getAudioContext(): AudioContext;
  export function initAudio(): Promise<void>;
  export function getSuperdoughAudioController(): {
    output: {
      destinationGain: AudioNode | null;
    };
  };
}
