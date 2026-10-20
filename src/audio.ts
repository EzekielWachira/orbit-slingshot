// Tiny synthesized sound effects — no audio files to load.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;

/** The shared audio graph (created on first use). Mute silences `master`, which music also feeds. */
export function audioGraph(): { ctx: AudioContext; master: GainNode } | null {
  if (!ctx) {
    try {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.5;
      master.connect(ctx.destination);
      // Nothing should keep playing in a background tab.
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) void ctx?.suspend();
        else void ctx?.resume();
      });
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended' && !document.hidden) void ctx.resume();
  return { ctx, master: master! };
}

function ensure(): AudioContext | null {
  if (muted) return null;
  return audioGraph()?.ctx ?? null;
}

function noiseBuffer(ac: AudioContext, seconds: number): AudioBuffer {
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * seconds), ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function tone(freq: number, start: number, dur: number, type: OscillatorType, vol: number, endFreq?: number) {
  const ac = ctx!;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, start + dur);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(vol, start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g).connect(master!);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}

function noise(start: number, dur: number, vol: number, fromHz: number, toHz: number) {
  const ac = ctx!;
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, dur);
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(fromHz, start);
  filter.frequency.exponentialRampToValueAtTime(toHz, start + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(vol, start);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(filter).connect(g).connect(master!);
  src.start(start);
}

export const sfx = {
  /** Call from a user gesture: browsers only allow audio to start after one. */
  unlock() {
    audioGraph();
  },
  launch(power: number) {
    const ac = ensure();
    if (!ac) return;
    const t = ac.currentTime;
    noise(t, 0.35, 0.25 + power * 0.25, 4000, 300);
    tone(180, t, 0.3, 'sine', 0.25, 520 + power * 400);
  },
  crash() {
    const ac = ensure();
    if (!ac) return;
    const t = ac.currentTime;
    noise(t, 0.8, 0.6, 1800, 60);
    tone(120, t, 0.5, 'triangle', 0.3, 40);
  },
  lost() {
    const ac = ensure();
    if (!ac) return;
    const t = ac.currentTime;
    tone(440, t, 0.6, 'sine', 0.15, 110);
  },
  win() {
    const ac = ensure();
    if (!ac) return;
    const t = ac.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      tone(f, t + i * 0.09, 0.9, 'sine', 0.18);
      tone(f * 2, t + i * 0.09, 0.5, 'triangle', 0.04);
    });
  },
  warp() {
    const ac = ensure();
    if (!ac) return;
    const t = ac.currentTime;
    tone(900, t, 0.35, 'sine', 0.14, 120);
    tone(140, t + 0.12, 0.35, 'sine', 0.12, 1100);
    noise(t, 0.3, 0.12, 6000, 500);
  },
  /** Proximity blip near the beacon; `close` 0–1 raises pitch and volume. */
  beep(close: number) {
    const ac = ensure();
    if (!ac) return;
    const t = ac.currentTime;
    const f = 720 + close * 900;
    tone(f, t, 0.07, 'sine', 0.08 + close * 0.06);
    tone(f * 2, t, 0.04, 'triangle', 0.02);
  },
  /** Rising pitch as you collect more in one flight. */
  dust(n: number) {
    const ac = ensure();
    if (!ac) return;
    const t = ac.currentTime;
    const f = 880 * Math.pow(2, (n - 1) * (4 / 12));
    tone(f, t, 0.25, 'triangle', 0.12);
    tone(f * 1.5, t + 0.05, 0.3, 'sine', 0.08);
  },
  click() {
    const ac = ensure();
    if (!ac) return;
    tone(880, ac.currentTime, 0.06, 'square', 0.04, 660);
  },
  setMuted(m: boolean) {
    muted = m;
    if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.5, ctx.currentTime, 0.02);
  },
  get muted() {
    return muted;
  },
};
