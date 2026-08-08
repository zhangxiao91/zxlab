import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import gsap from "gsap";
import {
  ambientDelay,
  CELL_HEIGHT,
  CELL_WIDTH,
  chooseAmbientAction,
  directionIndex,
  MANUAL_SEQUENCES,
  PET_STATES,
  spriteCell,
  type PetState,
} from "./pet-motion";
import {
  getPreferences,
  listenForAppErrors,
  listenForPreferences,
  saveCurrentPosition,
  startPetDrag,
  type PetPreferences,
} from "./platform";

const SCALE_BY_SIZE: Record<PetPreferences["size"], number> = {
  small: 0.68,
  medium: 0.82,
  large: 1,
};

type UiState = "default" | "loading" | "error" | "success";

export default function BoopiApp() {
  const [preferences, setPreferences] = useState<PetPreferences>({
    quiet: false,
    size: "medium",
    launchAtLogin: false,
  });
  const [state, setState] = useState<PetState>("idle");
  const [frame, setFrame] = useState(0);
  const [message, setMessage] = useState("Boopi 在这里。");
  const [messageKey, setMessageKey] = useState(0);
  const [messageVisible, setMessageVisible] = useState(false);
  const [uiState, setUiState] = useState<UiState>("loading");
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const preferencesRef = useRef(preferences);
  const statusRef = useRef<HTMLDivElement>(null);
  const frameTimer = useRef<number | undefined>(undefined);
  const ambientTimer = useRef<number | undefined>(undefined);
  const messageTimer = useRef<number | undefined>(undefined);
  const animationToken = useRef(0);
  const frameRef = useRef(0);
  const completedLoops = useRef(0);
  const lastAmbientState = useRef<PetState | undefined>(undefined);
  const manualIndex = useRef(Math.floor(Math.random() * MANUAL_SEQUENCES.length));
  const manualSequence = useRef(false);
  const dragged = useRef(false);
  const previousWindowX = useRef<number | undefined>(undefined);
  const dragSettler = useRef<number | undefined>(undefined);
  const reducedMotion = useRef(
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  const clearFrameTimer = () => window.clearTimeout(frameTimer.current);
  const clearAmbientTimer = () => window.clearTimeout(ambientTimer.current);

  const showMessage = useCallback((nextMessage: string, tone: UiState = "default") => {
    window.clearTimeout(messageTimer.current);
    setMessage(nextMessage);
    setMessageKey((value) => value + 1);
    setMessageVisible(true);
    if (tone !== "default") setUiState(tone);
    messageTimer.current = window.setTimeout(() => {
      setMessageVisible(false);
      if (tone !== "error") setUiState("default");
    }, 2_600);
  }, []);

  const paintIdle = useCallback(() => {
    manualSequence.current = false;
    animationToken.current += 1;
    clearFrameTimer();
    setState("idle");
    setFrame(0);
    frameRef.current = 0;
    completedLoops.current = 0;
  }, []);

  const scheduleAmbient = useCallback(() => {
    clearAmbientTimer();
    if (preferences.quiet || reducedMotion.current || manualSequence.current) return;
    ambientTimer.current = window.setTimeout(() => {
      const action = chooseAmbientAction(lastAmbientState.current);
      lastAmbientState.current = action.state;
      showMessage(action.message);
      runAnimationRef.current(action.state, 1, () => {
        paintIdle();
        scheduleAmbientRef.current();
      });
    }, ambientDelay());
  }, [paintIdle, preferences.quiet, showMessage]);

  const scheduleAmbientRef = useRef(scheduleAmbient);
  scheduleAmbientRef.current = scheduleAmbient;

  const runAnimation = useCallback(
    (nextState: PetState, loops = Number.POSITIVE_INFINITY, done?: () => void) => {
      clearFrameTimer();
      const token = ++animationToken.current;
      setState(nextState);
      setFrame(0);
      frameRef.current = 0;
      completedLoops.current = 0;

      if (reducedMotion.current) {
        if (done) frameTimer.current = window.setTimeout(done, 900);
        return;
      }

      const tick = () => {
        if (token !== animationToken.current) return;
        const current = PET_STATES[nextState];
        let nextFrame = frameRef.current + 1;
        if (nextFrame >= current.frames) {
          completedLoops.current += 1;
          if (completedLoops.current >= loops) {
            window.setTimeout(() => done?.(), 0);
            return;
          }
          nextFrame = 0;
        }
        frameRef.current = nextFrame;
        setFrame(nextFrame);
        frameTimer.current = window.setTimeout(tick, current.frameMs);
      };

      frameTimer.current = window.setTimeout(tick, PET_STATES[nextState].frameMs);
    },
    [],
  );

  const runAnimationRef = useRef(runAnimation);
  runAnimationRef.current = runAnimation;

  const startIdle = useCallback(() => {
    paintIdle();
    scheduleAmbientRef.current();
  }, [paintIdle]);

  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];

    void getPreferences()
      .then((value) => {
        if (disposed) return;
        preferencesRef.current = value;
        setPreferences(value);
        setRuntimeError(null);
        setUiState("default");
        startIdle();
      })
      .catch((cause) => {
        if (disposed) return;
        const text = cause instanceof Error ? cause.message : String(cause);
        setRuntimeError(text);
        setUiState("error");
        showMessage("Boopi 没能读到本地设置。", "error");
        runAnimationRef.current("failed", 1, paintIdle);
      });

    void listenForPreferences((value) => {
      const previous = preferencesRef.current;
      preferencesRef.current = value;
      setPreferences(value);
      setRuntimeError(null);
      if (previous.quiet !== value.quiet) {
        showMessage(
          value.quiet ? "Boopi 进入安静模式。" : "Boopi 恢复轻声活动。",
          "success",
        );
        startIdle();
      } else if (previous.size !== value.size) {
        const sizeLabel = value.size === "small" ? "小" : value.size === "large" ? "大" : "中";
        showMessage(`Boopi 调整为${sizeLabel}尺寸。`, "success");
        startIdle();
      } else if (previous.launchAtLogin !== value.launchAtLogin) {
        showMessage(
          value.launchAtLogin ? "Boopi 会在登录时出现。" : "Boopi 不再随登录启动。",
          "success",
        );
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else cleanups.push(unlisten);
    });

    void listenForAppErrors((text) => {
      setRuntimeError(text);
      setUiState("error");
      showMessage(text, "error");
      runAnimationRef.current("failed", 1, paintIdle);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else cleanups.push(unlisten);
    });

    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
      clearFrameTimer();
      clearAmbientTimer();
      window.clearTimeout(messageTimer.current);
      window.clearTimeout(dragSettler.current);
    };
  }, [paintIdle, showMessage, startIdle]);

  useEffect(() => {
    scheduleAmbient();
    return clearAmbientTimer;
  }, [preferences.quiet, scheduleAmbient]);

  useLayoutEffect(() => {
    const status = statusRef.current;
    if (!status || !messageVisible) return;
    const context = gsap.context(() => {
      gsap.fromTo(
        status,
        { autoAlpha: 0, y: 4 },
        {
          autoAlpha: 1,
          y: 0,
          duration: reducedMotion.current ? 0.12 : 0.22,
          ease: "power3.out",
        },
      );
    }, status);
    return () => context.revert();
  }, [messageKey, messageVisible]);

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (manualSequence.current || dragged.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const index = directionIndex(
      event.clientX - (rect.left + rect.width / 2),
      event.clientY - (rect.top + rect.height / 2),
    );
    animationToken.current += 1;
    clearFrameTimer();
    setState("looking");
    setFrame(index);
  };

  const handlePointerEnter = () => {
    clearAmbientTimer();
    if (preferences.quiet || manualSequence.current) return;
    showMessage("Boopi 在看你。");
  };

  const handlePointerLeave = () => {
    if (dragged.current || manualSequence.current) return;
    startIdle();
  };

  const handleClick = () => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    manualSequence.current = true;
    clearAmbientTimer();
    const sequence = MANUAL_SEQUENCES[manualIndex.current];
    manualIndex.current = (manualIndex.current + 1) % MANUAL_SEQUENCES.length;
    showMessage(sequence.message);
    runAnimation(sequence.state, 1, () => {
      if (!sequence.followUp) {
        startIdle();
        return;
      }
      showMessage(sequence.followUp.message, "success");
      runAnimationRef.current(sequence.followUp.state, 1, startIdle);
    });
  };

  const handlePointerDown = async (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    dragged.current = false;
    previousWindowX.current = undefined;
    clearAmbientTimer();

    const trackWindowMove = () => {
      const delta = window.screenX - (previousWindowX.current ?? window.screenX);
      if (previousWindowX.current !== undefined && Math.abs(delta) >= 1) {
        dragged.current = true;
        manualSequence.current = true;
        runAnimationRef.current(delta < 0 ? "runningLeft" : "runningRight");
      }
      previousWindowX.current = window.screenX;
      window.clearTimeout(dragSettler.current);
      dragSettler.current = window.setTimeout(() => {
        if (dragged.current) startIdle();
      }, 180);
    };

    const interval = window.setInterval(trackWindowMove, 50);
    try {
      await startPetDrag();
      trackWindowMove();
      if (dragged.current) {
        await saveCurrentPosition();
        setRuntimeError(null);
        showMessage("Boopi 记住这里了。", "success");
      }
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      setRuntimeError(text);
      showMessage("Boopi 没能移动窗口。", "error");
    } finally {
      window.clearInterval(interval);
      startIdle();
    }
  };

  const cell = spriteCell(state, frame);
  const scale = SCALE_BY_SIZE[preferences.size];
  const shellStyle = {
    "--pet-scale": scale,
  } as React.CSSProperties;
  const spriteStyle = {
    backgroundPosition: `${-cell.column * CELL_WIDTH}px ${-cell.row * CELL_HEIGHT}px`,
  };

  return (
    <main
      className="pet-shell"
      data-ui-state={uiState}
      data-quiet={preferences.quiet ? "true" : "false"}
      style={shellStyle}
      aria-label="Boopi 桌面伙伴"
    >
      <div
        ref={statusRef}
        className="status-ribbon"
        data-visible={messageVisible ? "true" : "false"}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="status-anchor" aria-hidden="true" />
        <span className="status-copy">{message}</span>
      </div>

      <div className="stage-anchor">
        <button
          className="pet-stage"
          type="button"
          aria-label="拖动 Boopi，或点按查看一个动作"
          aria-invalid={runtimeError ? "true" : undefined}
          disabled={uiState === "loading"}
          onClick={handleClick}
          onPointerDown={(event) => void handlePointerDown(event)}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
          onPointerMove={handlePointerMove}
        >
          <span className="pet-sprite" style={spriteStyle} aria-hidden="true" />
        </button>
      </div>
    </main>
  );
}
