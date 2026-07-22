import { useEffect, useState } from "react";
import { YuragiStyles, YuragiText } from "@yuragi-labs/react/static";
import outlines from "../../generated/yuragi-home-outlines.json";

export const welcomeYuragiShowEvent = "zxlab:welcome-yuragi-show";
export const welcomeYuragiHideEvent = "zxlab:welcome-yuragi-hide";

const text = "welcome to zxlab!";

export default function YuragiWelcomeMessage() {
  const [visible, setVisible] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const message = document.querySelector<HTMLElement>("[data-welcome-message]");
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReducedMotion(motionQuery.matches);
    const show = () => setVisible(true);
    const hide = () => setVisible(false);

    setVisible(Boolean(message && !message.hidden));
    updateMotion();
    window.addEventListener(welcomeYuragiShowEvent, show);
    window.addEventListener(welcomeYuragiHideEvent, hide);
    motionQuery.addEventListener("change", updateMotion);

    return () => {
      window.removeEventListener(welcomeYuragiShowEvent, show);
      window.removeEventListener(welcomeYuragiHideEvent, hide);
      motionQuery.removeEventListener("change", updateMotion);
    };
  }, []);

  return (
    <div className="welcome-yuragi-message" aria-hidden="true">
      <YuragiStyles />
      {visible && outlines.outlines[text] ? (
        <YuragiText
          text={text}
          outline={outlines.outlines[text]}
          size={52}
          maxWidth={760}
          hover={reducedMotion ? "none" : "outline"}
          transition={reducedMotion ? { enter: "none", exit: "none" } : { enter: "settle", exit: "scatter", speed: 1.05 }}
          className="welcome-yuragi-message__text"
        />
      ) : null}
    </div>
  );
}
