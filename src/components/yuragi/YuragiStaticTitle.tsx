import { useEffect, useRef, useState } from "react";
import { YuragiStyles, YuragiText } from "@yuragi-labs/react/static";
import type { StaticYuragiTextProps } from "@yuragi-labs/react/static";
import outlines from "../../generated/yuragi-outlines.json";

export const yuragiStaticOutlines = outlines.outlines;
export type YuragiStaticTitleText = keyof typeof yuragiStaticOutlines;

export type YuragiStaticTitleProps = Omit<StaticYuragiTextProps, "outline" | "text"> & {
  text: YuragiStaticTitleText;
  revealOnView?: boolean;
  motionPreset?: "intro" | "hero-loop" | "section-reveal";
  motionDisabled?: boolean;
};

const motionPresets = {
  intro: { enter: "settle", exit: "scatter", speed: 1.05 },
  "hero-loop": { enter: "settle", exit: "scatter", speed: 1.08 },
  "section-reveal": { enter: "settle", exit: "none", speed: 0.92 },
} as const;

export function YuragiStaticTitle({
  text,
  revealOnView = false,
  motionPreset = "section-reveal",
  motionDisabled = false,
  ...props
}: YuragiStaticTitleProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const [isVisible, setIsVisible] = useState(!revealOnView);
  const outline = yuragiStaticOutlines[text as YuragiStaticTitleText];

  useEffect(() => {
    if (!revealOnView) {
      setIsVisible(true);
      return;
    }

    const root = rootRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setIsVisible(true);
        observer.disconnect();
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, [revealOnView]);

  if (!outline) {
    if (import.meta.env.DEV) throw new Error(`Yuragi outline was not generated for: ${text}`);
    return <span className={props.className}>{text}</span>;
  }

  return (
    <>
      <YuragiStyles />
      <span ref={rootRef} className="yuragi-static-title">
        {isVisible ? (
          <YuragiText
            {...props}
            text={text}
            outline={outline}
            fallback={props.fallback ?? "text"}
            transition={motionDisabled ? { enter: "none", exit: "none" } : motionPresets[motionPreset]}
          />
        ) : (
          <span className={props.className}>{text}</span>
        )}
      </span>
    </>
  );
}
