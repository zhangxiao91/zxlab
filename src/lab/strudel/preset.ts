export const STRUDEL_TRANCE_PRESET = `setcpm(138 / 4)

stack(
  s("bd*4")
    .bank("RolandTR909")
    .gain(.9),

  s("~ cp ~ cp")
    .bank("RolandTR909")
    .gain(.4),

  s("hh*16")
    .bank("RolandTR909")
    .gain("[.15 .3]*8"),

  note("~ c2 ~ c2 ~ c2 ~ c2")
    .s("sawtooth")
    .lpf(700)
    .release(.15)
    .gain(.5),

  note("<c4 eb4 g4 bb4>*4")
    .s("sawtooth")
    .lpf(sine.range(600, 4200).slow(16))
    .release(.16)
    .delay(.4)
    .room(.3)
    .gain(.24)
)
`;
