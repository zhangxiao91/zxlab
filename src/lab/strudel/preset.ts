export interface StrudelPreset {
  id: string;
  title: string;
  description: string;
  bpm: number;
  source: string;
}

export const STRUDEL_DREAM_TRANCE_PRESET = String.raw`setcpm(136 / 4)

const chords = note("<[a3,c4,e4] [g3,b3,e4] [f3,a3,c4] [g3,b3,d4]>")
const roots = note("<a2 e2 f2 g2>")
const kick = s("bd*4").gain(0.95).lpf(5000)
const clap = s("~ cp ~ cp").gain(0.30).room(0.18)
const openHat = s("~ oh ~ oh ~ oh ~ oh").gain(0.15).hpf(5000).room(0.25)
const closedHat = s("hh*16").gain("0.08 0.035 0.055 0.03").hpf(6500).pan(sine.range(-0.25, 0.25).slow(8))
const offbeatBass = roots.struct("~ x ~ x ~ x ~ x").s("sawtooth").attack(0.002).release(0.18).lpf(720).lpq(9).gain(0.31)
const subBass = roots.struct("~ x ~ x ~ x ~ x").s("sine").attack(0.002).release(0.13).gain(0.22)
const gatedChords = chords.struct("~ x ~ x ~ x ~ x").s("sawtooth").attack(0.008).release(0.28).lpf(2800).lpq(4).gain(0.13).room(0.52).size(0.82).delay(0.16).delaytime(0.25).delayfeedback(0.28).jux(rev)
const pad = chords.s("sawtooth").attack(0.35).release(3.4).lpf(1700).gain(0.075).room(0.86).size(0.94).jux(rev)
const arp = note("<[a4 e5 a5 c6 e5 a5 c6 e6] [g4 e5 g5 b5 e5 g5 b5 e6] [f4 c5 f5 a5 c5 f5 a5 c6] [g4 d5 g5 b5 d5 g5 b5 d6]>").s("triangle").attack(0.002).release(0.14).lpf(5000).lpq(5).gain(0.105).delay(.38).delaytime(.1875).delayfeedback(.46).room(.42).pan(sine.range(-.45, .45).slow(8))
const lead = note("<[e6 ~ c6 ~ b5 a5 ~ e5] [b5 c6 e6 ~ d6 b5 ~ g5] [a5 c6 e6 f6 e6 d6 c6 a5] [b5 ~ a5 g5 a5 b5 e6 ~]>").s("sawtooth").attack(.015).release(.42).lpf(5200).lpq(5).gain(.135).room(.65).size(.88).delay(.38).delaytime(.375).delayfeedback(.42).jux(rev)

const intro = stack(
  kick.gain("<.55 .67 .78 .88>").lpf("<700 1200 2400 5000>"),
  closedHat.gain("<.015 .03 .05 .07>"),
  openHat.gain("<0 .04 .08 .12>"),
  offbeatBass.lpf("<220 330 470 620>").gain("<.08 .14 .22 .29>"),
  pad.lpf("<650 900 1300 1800>"),
  arp.lpf("<1000 1800 3000 4600>").gain("<.025 .045 .075 .1>")
)
const drive = stack(kick, clap, closedHat, openHat, offbeatBass, subBass, gatedChords, pad, arp, s("<~ ~ ~ [sd*8]>").gain(.16).room(.25))
const peak = stack(
  kick.gain(1), clap.gain(.34), closedHat.gain(".095 .035 .065 .03"), openHat.gain(.17),
  s("~ ~ ~ [cp cp]").gain(.12).room(.45), offbeatBass.lpf(sine.range(650, 950).slow(4)).gain(.34),
  subBass.gain(.24), gatedChords.lpf(sine.range(2600, 4300).slow(4)).gain(.16), pad.lpf(2300).gain(.09),
  arp.lpf(sine.range(4000, 6800).slow(4)).gain(.12), lead, lead.add(12).gain(.035).hpf(2600).room(.8)
)
const outro = stack(
  kick.gain("<.9 .72 .45 0>"), clap.gain("<.3 .22 .1 0>"), closedHat.gain("<.075 .05 .025 0>"), openHat.gain("<.14 .1 .04 0>"),
  offbeatBass.lpf("<650 480 330 180>").gain("<.31 .23 .14 0>"), subBass.gain("<.2 .14 .06 0>"),
  gatedChords.lpf("<2800 1900 1100 500>").gain("<.14 .11 .07 .02>"), pad.lpf("<1800 1400 950 600>").release(4),
  arp.lpf("<4800 3200 1900 900>").gain("<.1 .07 .035 0>")
)
arrange([4, intro], [4, drive], [5, peak], [4, outro])`;

export const STRUDEL_TRANCE_PRESET = STRUDEL_DREAM_TRANCE_PRESET;

export const STRUDEL_FUTURE_BASS_PRESET = String.raw`setcpm(144 / 4)

// Future Bass — 30 seconds
// 18 cycles × 4 beats ÷ 144 BPM = 30 seconds

// ============================================================
// Harmony
// ============================================================

const chords = note(\`
  <[d4,fs4,a4,cs5]
   [b3,d4,fs4,a4]
   [g3,b3,d4,fs4]
   [a3,cs4,e4,b4]>
\`)

// 每一个音都明确写出，保证 bass 被重新触发
const subNotes = note(\`
  <[d2 ~ d2 d2 ~ d2 ~ d2]
   [b1 ~ b1 ~ b1 b1 ~ b1]
   [g1 ~ g1 g1 ~ ~ g1 g1]
   [a1 ~ a1 ~ a1 a1 a1 ~]>
\`)

const bassNotes = note(\`
  <[d3 ~ d3 d3 ~ d3 ~ d3]
   [b2 ~ b2 ~ b2 b2 ~ b2]
   [g2 ~ g2 g2 ~ ~ g2 g2]
   [a2 ~ a2 ~ a2 a2 a2 ~]>
\`)

const bassTopNotes = note(\`
  <[a3 ~ d4 a3 ~ fs3 ~ a3]
   [fs3 ~ b3 fs3 ~ d3 ~ fs3]
   [d3 ~ g3 d3 ~ ~ b3 d3]
   [e3 ~ a3 ~ cs4 e3 b3 ~]>
\`)

// ============================================================
// Drums
// ============================================================

const kick = s(\`
  <[bd ~ ~ bd ~ ~ bd ~]
   [bd ~ ~ ~ bd ~ bd ~]
   [bd ~ bd ~ ~ ~ bd ~]
   [bd ~ ~ bd ~ bd ~ ~]>
\`)
  .gain(0.92)
  .lpf(5200)

const snare = s("~ ~ ~ ~ sd ~ ~ ~")
  .gain(0.72)
  .room(0.14)

const clap = s("~ ~ ~ ~ cp ~ ~ ~")
  .gain(0.24)
  .room(0.32)

const hats = s("hh*16")
  .gain("0.07 0.025 0.045 0.025")
  .hpf(6200)
  .pan(sine.range(-0.3, 0.3).slow(6))

const openHat = s("~ ~ oh ~ ~ ~ oh ~")
  .gain(0.1)
  .hpf(5200)
  .room(0.25)

// ============================================================
// Bass
// ============================================================

// 纯低频层
const subBass = subNotes
  .s("sine")
  .attack(0.002)
  .release(0.28)
  .gain(0.34)

// 主要可听 bass
const mainBass = bassNotes
  .s("sawtooth")
  .attack(0.002)
  .release(0.22)
  .lpf(1250)
  .lpq(7)
  .gain(0.29)

// 方波增加中频和轮廓
const squareBass = bassNotes
  .s("square")
  .attack(0.002)
  .release(0.15)
  .hpf(130)
  .lpf(1900)
  .lpq(4)
  .gain(0.105)

// 更高的跳音层
const bassTop = bassTopNotes
  .s("sawtooth")
  .attack(0.002)
  .release(0.13)
  .hpf(350)
  .lpf(2600)
  .lpq(6)
  .gain(0.1)

// ============================================================
// Chords
// ============================================================

const pad = chords
  .s("triangle")
  .attack(0.42)
  .release(3)
  .lpf(2100)
  .gain(0.055)
  .room(0.82)
  .size(0.94)
  .jux(rev)

const chordChops = note(\`
  <[[d4,fs4,a4,cs5] ~ [d4,fs4,a4,cs5] [d4,fs4,a4,cs5]
      ~ [d4,fs4,a4,cs5] ~ [d4,fs4,a4,cs5]]

   [[b3,d4,fs4,a4] ~ [b3,d4,fs4,a4] ~
      [b3,d4,fs4,a4] [b3,d4,fs4,a4] ~ [b3,d4,fs4,a4]]

   [[g3,b3,d4,fs4] ~ [g3,b3,d4,fs4] [g3,b3,d4,fs4]
      ~ ~ [g3,b3,d4,fs4] [g3,b3,d4,fs4]]

   [[a3,cs4,e4,b4] ~ [a3,cs4,e4,b4] ~
      [a3,cs4,e4,b4] [a3,cs4,e4,b4] [a3,cs4,e4,b4] ~]>
\`)
  .s("sawtooth")
  .attack(0.008)
  .release(0.2)
  .lpf(4300)
  .lpq(4)
  .gain(0.12)
  .room(0.58)
  .size(0.86)
  .delay(0.16)
  .delaytime(0.25)
  .delayfeedback(0.25)
  .jux(rev)

const highChops = chordChops
  .add(12)
  .hpf(1800)
  .lpf(7000)
  .gain(0.023)
  .room(0.72)

// ============================================================
// Melody
// ============================================================

const sparkle = note(\`
  <[d5 a5 cs6 fs6 a5 fs6 cs6 a5]
   [b4 fs5 a5 d6 fs5 d6 a5 fs5]
   [g4 d5 fs5 b5 d5 b5 fs5 d5]
   [a4 e5 b5 cs6 e5 cs6 b5 e5]>
\`)
  .s("triangle")
  .attack(0.003)
  .release(0.15)
  .lpf(6200)
  .gain(0.07)
  .delay(0.4)
  .delaytime(0.1875)
  .delayfeedback(0.43)
  .room(0.45)
  .pan(sine.range(-0.5, 0.5).slow(8))

const vocalChop = note(\`
  <[a5 ~ fs5 a5 ~ cs6 ~ a5]
   [fs5 ~ d5 fs5 ~ a5 ~ fs5]
   [d5 ~ b4 d5 ~ fs5 ~ d5]
   [e5 ~ cs5 e5 ~ b5 ~ e5]>
\`)
  .s("sine")
  .attack(0.008)
  .release(0.25)
  .lpf(5000)
  .gain(0.105)
  .room(0.66)
  .size(0.86)
  .delay(0.35)
  .delaytime(0.25)
  .delayfeedback(0.38)
  .jux(rev)

const lead = note(\`
  <[fs5 ~ a5 cs6 ~ a5 fs5 ~]
   [d5 fs5 a5 ~ fs5 d5 ~ b4]
   [b4 d5 fs5 b5 ~ a5 fs5 d5]
   [e5 ~ a5 b5 cs6 b5 a5 ~]>
\`)
  .s("sawtooth")
  .attack(0.014)
  .release(0.36)
  .lpf(5200)
  .lpq(4)
  .gain(0.085)
  .room(0.58)
  .size(0.84)
  .delay(0.28)
  .delaytime(0.375)
  .delayfeedback(0.32)
  .jux(rev)

// ============================================================
// Arrangement
// ============================================================

// 0–6.67 s
const intro = stack(
  pad
    .lpf("<650 1000 1500 2100>")
    .gain("<0.03 0.04 0.05 0.06>"),

  sparkle
    .lpf("<1300 2400 3900 6100>")
    .gain("<0.015 0.03 0.05 0.07>"),

  vocalChop
    .gain("<0 0.025 0.055 0.085>"),

  s("~ ~ ~ ~ hh ~ hh ~")
    .gain("<0.015 0.025 0.04 0.055>")
    .hpf(6000),

  note("<d2 b1 g1 a1>")
    .s("sine")
    .attack(0.02)
    .release(0.7)
    .gain(0.16)
)

// 6.67–13.33 s
const build = stack(
  kick.gain("<0.35 0.5 0.68 0.82>"),

  snare.gain("<0.28 0.4 0.55 0.68>"),

  hats.gain("<0.015 0.03 0.045 0.06>"),

  openHat.gain("<0 0.035 0.065 0.09>"),

  pad,

  chordChops
    .lpf("<900 1600 2700 4200>")
    .gain("<0.025 0.05 0.08 0.11>"),

  subBass
    .lpf("<160 220 320 480>")
    .gain("<0.05 0.1 0.18 0.27>"),

  sparkle,
  vocalChop,

  s("<~ ~ [sd*8] [sd*16]>")
    .gain("<0 0 0.15 0.26>")
    .room(0.2)
)

// 13.33–15 s
// 一小段 bass fakeout，让低频先单独露出来
const fakeout = stack(
  subBass.gain(0.38),

  mainBass
    .lpf(1500)
    .gain(0.34),

  squareBass.gain(0.13),

  bassTop.gain(0.11),

  s("bd ~ ~ bd ~ ~ bd ~")
    .gain(0.82),

  vocalChop
    .gain(0.07)
)

// 15–23.33 s
const drop = stack(
  kick,
  snare,
  clap,
  hats,
  openHat,

  // bass 是 drop 的主角
  subBass,
  mainBass,
  squareBass,
  bassTop,

  // 给 bass 留出空间
  chordChops
    .lpf(sine.range(2800, 5000).slow(4))
    .gain(0.105),

  highChops,
  pad.gain(0.04),

  sparkle.gain(0.075),
  vocalChop.gain(0.11),
  lead,

  s("~ ~ ~ [cp cp] ~ ~ [sd sd] [cp cp]")
    .gain(0.09)
    .room(0.38)
)

// 23.33–30 s
const outro = stack(
  kick.gain("<0.78 0.55 0.28 0>"),

  snare.gain("<0.62 0.4 0.18 0>"),

  hats.gain("<0.055 0.035 0.015 0>"),

  subBass
    .lpf("<500 360 240 140>")
    .gain("<0.3 0.2 0.09 0>"),

  mainBass
    .lpf("<1200 850 500 230>")
    .gain("<0.27 0.18 0.08 0>"),

  squareBass
    .gain("<0.09 0.055 0.02 0>"),

  chordChops
    .lpf("<3900 2600 1400 600>")
    .gain("<0.1 0.07 0.035 0>"),

  pad
    .lpf("<2100 1550 950 520>")
    .release(4),

  sparkle
    .lpf("<5000 3200 1700 750>")
    .gain("<0.065 0.04 0.018 0>"),

  vocalChop
    .gain("<0.08 0.05 0.02 0>")
)

arrange(
  [4, intro],
  [4, build],
  [1, fakeout],
  [5, drop],
  [4, outro]
`;

export const STRUDEL_HARDSTYLE_PRESET = String.raw`setcpm(160 / 4)

// Euphoric Hardstyle — 30 seconds
// 20 cycles × 4 beats ÷ 160 BPM = 30 seconds
//
// 0–6s    Intro
// 6–12s   Melodic build
// 12–21s  Drop A
// 21–30s  Drop B

const roots =
  note("<e1 c1 g0 d1>")

const chords =
  note(\`
    <[e3,g3,b3]
     [c3,e3,g3]
     [g2,b2,d3]
     [d3,fs3,a3]>
  \`)

// ==================================================
// KICK
// ==================================================

// 主 punch
const kickPunch =
  s("bd*4")
    .attack(0.001)
    .release(0.085)
    .lpf(5200)
    .shape(0.52)
    .gain(0.82)

// 极轻的高频 click
const kickClick =
  s("bd*4")
    .attack(0.001)
    .release(0.024)
    .hpf(1700)
    .lpf(6800)
    .shape(0.36)
    .gain(0.075)

// Tonal tail
const kickTail =
  note(\`
    <[e2 e1 e1 e1]
     [c2 c1 c1 c1]
     [g1 g0 g0 g0]
     [d2 d1 d1 d1]>
  \`)
    .fast(4)
    .s("sawtooth")
    .attack(0.003)
    .release(0.12)
    .lpf(400)
    .lpq(6)
    .shape(0.53)
    .gain(0.22)

// 低频 body
const kickSub =
  roots
    .struct("x*4")
    .s("sine")
    .attack(0.002)
    .release(0.15)
    .gain(0.16)

// ==================================================
// DRUMS
// ==================================================

const clap =
  s("~ cp ~ cp")
    .gain(0.21)
    .room(0.17)

const closedHat =
  s("hh*16")
    .gain("0.052 0.017 0.034 0.017")
    .hpf(6200)
    .pan(sine.range(-0.22, 0.22).slow(8))

const openHat =
  s("~ oh ~ oh")
    .gain(0.09)
    .hpf(5000)
    .room(0.24)

const ride =
  s("~ ride ~ ride")
    .gain(0.045)
    .hpf(4600)
    .room(0.3)

// ==================================================
// ATMOSPHERE
// ==================================================

const pad =
  chords
    .s("sawtooth")
    .attack(0.5)
    .release(3.8)
    .lpf(1850)
    .lpq(3)
    .gain(0.065)
    .room(0.86)
    .size(0.94)
    .jux(rev)

const piano =
  chords
    .struct("x ~ ~ x ~ ~ x ~")
    .s("triangle")
    .attack(0.008)
    .release(0.55)
    .lpf(3200)
    .gain(0.078)
    .room(0.58)
    .size(0.82)
    .delay(0.22)
    .delaytime(0.375)
    .delayfeedback(0.3)

// ==================================================
// SUPERSAW
// ==================================================

const supersaw =
  chords
    .struct("x ~ x ~ ~ x ~ x")
    .s("sawtooth")
    .attack(0.012)
    .release(0.27)
    .lpf(4000)
    .lpq(4)
    .gain(0.125)
    .room(0.54)
    .size(0.86)
    .delay(0.14)
    .delaytime(0.25)
    .delayfeedback(0.22)
    .jux(rev)

const supersawHigh =
  supersaw
    .add(12)
    .hpf(1500)
    .lpf(6800)
    .gain(0.025)
    .room(0.72)

// ==================================================
// ARPEGGIO
// ==================================================

const arp =
  note(\`
    <[e4 b4 e5 g5 b4 e5 g5 b5]
     [c4 g4 c5 e5 g4 c5 e5 g5]
     [g3 d4 g4 b4 d4 g4 b4 d5]
     [d4 a4 d5 fs5 a4 d5 fs5 a5]>
  \`)
    .s("triangle")
    .attack(0.003)
    .release(0.15)
    .lpf(5400)
    .gain(0.07)
    .delay(0.4)
    .delaytime(0.1875)
    .delayfeedback(0.44)
    .room(0.48)
    .pan(sine.range(-0.48, 0.48).slow(8))

// ==================================================
// LEAD
// ==================================================

const melody =
  note(\`
    <[b4 ~ b4 e5 ~ g5 fs5 e5]
     [g4 ~ g4 c5 ~ e5 d5 c5]
     [d5 ~ d5 g5 ~ b5 a5 g5]
     [a4 b4 d5 fs5 ~ e5 d5 a4]>
  \`)
    .s("sawtooth")
    .attack(0.014)
    .release(0.33)
    .lpf(5400)
    .lpq(4)
    .gain(0.142)
    .room(0.6)
    .size(0.86)
    .delay(0.28)
    .delaytime(0.25)
    .delayfeedback(0.32)
    .jux(rev)

const melodyHigh =
  melody
    .add(12)
    .hpf(1900)
    .lpf(7000)
    .gain(0.027)
    .room(0.74)

const counterMelody =
  note(\`
    <[e5 ~ g5 ~ b5 ~ g5 ~]
     [c5 ~ e5 ~ g5 ~ e5 ~]
     [g5 ~ b5 ~ d6 ~ b5 ~]
     [fs5 ~ a5 ~ d6 ~ a5 ~]>
  \`)
    .s("triangle")
    .attack(0.01)
    .release(0.3)
    .lpf(4600)
    .gain(0.048)
    .room(0.68)
    .delay(0.34)
    .delaytime(0.375)
    .delayfeedback(0.38)
    .pan(sine.range(-0.32, 0.32).slow(6))

// 很轻的高频装饰
const softScreech =
  note(\`
    <[e6 ~ ~ b5 ~ ~ e6 ~]
     [c6 ~ ~ g5 ~ ~ c6 ~]
     [g6 ~ ~ d6 ~ ~ g6 ~]
     [d6 ~ ~ a5 ~ ~ d6 ~]>
  \`)
    .s("sawtooth")
    .attack(0.003)
    .release(0.08)
    .hpf(1800)
    .lpf(5600)
    .lpq(9)
    .shape(0.34)
    .gain(0.02)
    .room(0.26)
    .pan(sine.range(-0.38, 0.38).slow(4))

// ==================================================
// INTRO — 0–6 seconds
// 轻 kick，像从远处逐渐靠近
// ==================================================

const intro = stack(
  kickPunch
    .gain("<0.12 0.18 0.27 0.38>")
    .shape("<0.18 0.22 0.28 0.34>")
    .lpf("<450 750 1300 2300>")
    .room(0.08),

  kickTail
    .gain("<0.01 0.025 0.05 0.09>")
    .shape(0.25)
    .lpf("<90 130 180 240>"),

  kickSub
    .gain("<0.006 0.016 0.035 0.065>"),

  closedHat
    .gain("<0.004 0.01 0.02 0.033>"),

  openHat
    .gain("<0 0.01 0.026 0.05>")
    .room(0.4),

  pad
    .lpf("<420 650 1050 1700>")
    .gain("<0.045 0.052 0.06 0.068>"),

  arp
    .lpf("<650 1200 2300 4200>")
    .gain("<0.01 0.022 0.04 0.06>")
)

// ==================================================
// BUILD — 6–12 seconds
// kick 撤掉，让旋律成为中心
// ==================================================

const build = stack(
  pad
    .lpf("<1700 2400 3200 4400>")
    .gain("<0.068 0.072 0.076 0.08>"),

  piano
    .gain("<0.04 0.056 0.07 0.084>"),

  arp
    .lpf("<3200 4100 5000 6200>")
    .gain("<0.045 0.056 0.068 0.08>"),

  melody
    .lpf("<1200 2300 3700 5400>")
    .gain("<0.035 0.07 0.108 0.142>"),

  melodyHigh
    .gain("<0 0.007 0.016 0.027>"),

  counterMelody
    .gain("<0 0.012 0.028 0.046>"),

  // 逐步加速的 snare roll
  s("<sd*4 sd*8 sd*16 sd*32>")
    .gain("<0.07 0.105 0.155 0.22>")
    .room(0.26),

  s("<~ ~ [cp*4] [cp*8]>")
    .gain("<0 0 0.055 0.105>")
    .room(0.34),

  // 最后一拍吸气式 open hat
  s("<~ ~ ~ oh>")
    .gain("<0 0.03 0.075 0.14>")
    .room(0.75)
)

// ==================================================
// DROP A — 12–21 seconds
// 第一次完整落地
// ==================================================

const dropA = stack(
  kickPunch
    .gain(0.84)
    .shape(0.54)
    .lpf(5400),

  kickClick
    .gain(0.078),

  kickTail
    .gain(0.235)
    .shape(0.56)
    .lpf(410),

  kickSub
    .gain(0.175),

  clap
    .gain(0.215),

  closedHat
    .gain("0.052 0.017 0.034 0.017"),

  openHat
    .gain(0.092),

  supersaw
    .lpf(sine.range(3000, 4500).slow(4))
    .gain(0.12),

  supersawHigh
    .gain(0.024),

  pad
    .lpf(2150)
    .gain(0.052),

  melody
    .gain(0.142),

  melodyHigh
    .gain(0.026),

  arp
    .gain(0.064),

  softScreech
    .gain(0.018),

  s("<~ ~ ~ [cp cp] ~ ~ ~ [sd*4]>")
    .gain(0.052)
    .room(0.3)
)

// ==================================================
// DROP B — 21–30 seconds
// kick 更重，旋律层次也再增加
// ==================================================

const dropB = stack(
  kickPunch
    .gain(0.9)
    .shape(0.58)
    .lpf(5800),

  kickClick
    .gain(0.09),

  kickTail
    .gain(0.255)
    .shape(0.6)
    .lpf(440),

  kickSub
    .gain(0.185),

  clap
    .gain(0.225),

  closedHat
    .gain("0.058 0.019 0.038 0.019"),

  openHat
    .gain(0.098),

  ride
    .gain(0.047),

  supersaw
    .struct("x ~ x x ~ x ~ x")
    .lpf(sine.range(3300, 5000).slow(4))
    .gain(0.13),

  supersawHigh
    .gain(0.028),

  pad
    .lpf(2350)
    .gain(0.055),

  melody
    .gain(0.148),

  melodyHigh
    .gain(0.03),

  counterMelody
    .gain(0.043),

  arp
    .gain(0.07),

  softScreech
    .gain(0.022),

  s("<~ ~ ~ [cp cp] ~ [sd*4] ~ [sd*8]>")
    .gain(0.064)
    .room(0.32)
)

// ==================================================
// ARRANGEMENT
// ==================================================

arrange(
  [4, intro],
  [4, build],
  [6, dropA],
  [6, dropB]
`;

export const STRUDEL_PRESETS: StrudelPreset[] = [
  { id: "dream-trance", title: "Dream Trance", description: "136 BPM · gated supersaw, offbeat bass, evolving arp", bpm: 136, source: STRUDEL_DREAM_TRANCE_PRESET },
  { id: "future-bass", title: "Future Bass", description: "144 BPM · layered bass, chord chops, melodic drop", bpm: 144, source: STRUDEL_FUTURE_BASS_PRESET },
  { id: "euphoric-hardstyle", title: "Euphoric Hardstyle", description: "160 BPM · punch kick, supersaw, euphoric drop", bpm: 160, source: STRUDEL_HARDSTYLE_PRESET },
];

export const DEFAULT_STRUDEL_PRESET_ID = STRUDEL_PRESETS[0].id;
