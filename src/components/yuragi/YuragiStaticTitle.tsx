import { useEffect, useRef, useState } from "react";
import { YuragiStyles, YuragiText } from "@yuragi-labs/react/static";
import type { StaticYuragiTextProps } from "@yuragi-labs/react/static";
import outlines from "../../generated/yuragi-home-outlines.json";

export const yuragiStaticOutlines = outlines.outlines;
export type YuragiStaticTitleText = keyof typeof yuragiStaticOutlines;

export type YuragiStaticTitleProps = Omit<StaticYuragiTextProps, "outline" | "text"> & {
  text: string;
  revealOnView?: boolean;
};

export function YuragiStaticTitle({ text, revealOnView = false, ...props }: YuragiStaticTitleProps) {
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

  return (
    <>
      <YuragiStyles />
      <span ref={rootRef} className="yuragi-static-title">
        {isVisible ? (
          <YuragiText {...props} text={text} outline={outline} fallback={props.fallback ?? "text"} />
        ) : (
          <span className={props.className}>{text}</span>
        )}
      </span>
    </>
  );
}
