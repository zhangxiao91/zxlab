import { useEffect, useRef, useState } from "react";
import { HOME_HERO_WORDS } from "../../data/home-hero";
import { welcomeFinishedEvent } from "../welcome/welcome-config";
import { YuragiStaticTitle } from "../yuragi/YuragiStaticTitle";

const HOLD_DURATION = 1650;

export default function YuragiHomeLoop() {
  const rootRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | undefined>();
  const activeRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [wordIndex, setWordIndex] = useState(0);
  const [motionKey, setMotionKey] = useState(0);

  useEffect(() => {
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReducedMotion(motionQuery.matches);
    const reveal = () => setReady(true);

    updateMotion();
    if (document.documentElement.classList.contains("welcome-pending")) {
      window.addEventListener(welcomeFinishedEvent, reveal, { once: true });
    } else {
      reveal();
    }
    motionQuery.addEventListener("change", updateMotion);

    return () => {
      window.removeEventListener(welcomeFinishedEvent, reveal);
      motionQuery.removeEventListener("change", updateMotion);
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const root = rootRef.current;
    if (!root) return;

    const syncActive = () => {
      const nextActive = !document.hidden && root.dataset.inView === "true";
      const wasActive = activeRef.current;
      activeRef.current = nextActive;
      setActive(nextActive);
      if (nextActive && !wasActive) setMotionKey((current) => current + 1);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        root.dataset.inView = String(entry.isIntersecting);
        syncActive();
      },
      { threshold: 0.04 },
    );

    root.dataset.inView = "true";
    observer.observe(root);
    document.addEventListener("visibilitychange", syncActive);
    syncActive();

    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", syncActive);
    };
  }, [ready]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const scheduleNextWord = () => {
    window.clearTimeout(timerRef.current);
    if (reducedMotion || !activeRef.current) return;
    timerRef.current = window.setTimeout(() => {
      if (!activeRef.current) return;
      setWordIndex((current) => (current + 1) % HOME_HERO_WORDS.length);
    }, HOLD_DURATION);
  };

  const word = HOME_HERO_WORDS[wordIndex];

  return (
    <div ref={rootRef} className="home-yuragi-loop" aria-hidden="true">
      {ready ? (
        <YuragiStaticTitle
          key={`${word}-${motionKey}`}
          text={word}
          size={240}
          maxWidth={2100}
          hover="outline"
          transition={reducedMotion || !active ? { enter: "none", exit: "none" } : { enter: "settle", exit: "scatter", speed: 1.08 }}
          className="home-yuragi-loop__text"
          onEnterComplete={scheduleNextWord}
        />
      ) : null}
    </div>
  );
}
