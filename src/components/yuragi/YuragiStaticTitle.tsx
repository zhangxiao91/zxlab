import { YuragiStyles, YuragiText } from "@yuragi-labs/react/static";
import type { StaticYuragiTextProps } from "@yuragi-labs/react/static";
import outlines from "../../generated/yuragi-home-outlines.json";

export const yuragiStaticOutlines = outlines.outlines;
export type YuragiStaticTitleText = keyof typeof yuragiStaticOutlines;

export type YuragiStaticTitleProps = Omit<StaticYuragiTextProps, "outline" | "text"> & {
  text: string;
};

export function YuragiStaticTitle({ text, ...props }: YuragiStaticTitleProps) {
  const outline = yuragiStaticOutlines[text as YuragiStaticTitleText];

  return (
    <>
      <YuragiStyles />
      <YuragiText {...props} text={text} outline={outline} fallback={props.fallback ?? "text"} />
    </>
  );
}
