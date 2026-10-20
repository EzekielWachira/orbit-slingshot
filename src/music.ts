// Generative ambient soundtrack: slow pad chords plus sparse pentatonic plucks.
// `setIntensity` opens the filter and thickens the plucks as the probe nears the beacon.
import { audioGraph } from './audio.ts';

const CHORDS = [
  [45, 48, 52, 57], // Am
  [41, 45, 48, 52], // Fmaj7
  [36, 43, 48, 52], // C
  [43, 47, 50, 55], // G
];
const SCALE = [57, 60, 62, 64, 67, 69, 72, 74, 76, 79];
const CHORD_LEN = 8;
const BEAT = 0.42;
const LOOKAHEAD = 0.6;

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

class Music {
  private enabled = true;
  private timer = 0;
  private intensity = 0.2;
  private nodes: { ctx: AudioContext; out: GainNode; padFilter: BiquadFilterNode; send: GainNode } | null = null;
  private nextChord = 0;
  private chordIdx = 0;
  private nextNote = 0;
  private lastNote = 4;

  /** `startNow` false just records the preference (audio may only start after a user gesture). */
  setEnabled(on: boolean, startNow = true) {
    this.enabled = on;
    if (!on) this.stop();
    else if (startNow) this.start();
  }

  /** Safe to call often; only does work the first time (after a user gesture). */
  start() {
    if (!this.enabled || this.nodes) return;
    const g = audioGraph();
    if (!g) return;
    const { ctx, master } = g;

    const out = ctx.createGain();
    out.gain.value = 0;
    out.gain.setTargetAtTime(this.level(), ctx.currentTime, 1.5);
    out.connect(master);

    const padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.Q.value = 0.7;
    padFilter.frequency.value = this.cutoff();
    padFilter.connect(out);

    // A filtered feedback delay stands in for reverb.
    const send = ctx.createGain();
    send.gain.value = 0.45;
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.36;
    const fb = ctx.createGain();
    fb.gain.value = 0.42;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2400;
    send.connect(delay).connect(damp).connect(fb).connect(delay);
    damp.connect(out);

    this.nodes = { ctx, out, padFilter, send };
    this.nextChord = ctx.currentTime + 0.1;
    this.nextNote = ctx.currentTime + 1;
    this.timer = window.setInterval(() => this.tick(), 200);
  }

  private stop() {
    if (!this.nodes) return;
    const { ctx, out } = this.nodes;
    clearInterval(this.timer);
    out.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
    const old = out;
    setTimeout(() => old.disconnect(), 2500);
    this.nodes = null;
  }

  setIntensity(v: number) {
    if (Math.abs(v - this.intensity) < 0.03) return;
    this.intensity = v;
    if (!this.nodes) return;
    const { ctx, out, padFilter } = this.nodes;
    padFilter.frequency.setTargetAtTime(this.cutoff(), ctx.currentTime, 0.6);
    out.gain.setTargetAtTime(this.level(), ctx.currentTime, 0.8);
  }

  private cutoff() {
    return 380 + this.intensity * 2600;
  }

  private level() {
    return 0.16 + this.intensity * 0.2;
  }

  private tick() {
    if (!this.nodes) return;
    const now = this.nodes.ctx.currentTime;
    while (this.nextChord < now + LOOKAHEAD) {
      this.chord(CHORDS[this.chordIdx % CHORDS.length], this.nextChord);
      this.chordIdx++;
      this.nextChord += CHORD_LEN;
    }
    while (this.nextNote < now + LOOKAHEAD) {
      if (Math.random() < 0.18 + this.intensity * 0.5) this.pluck(this.nextNote);
      this.nextNote += BEAT * (Math.random() < 0.2 ? 2 : 1);
    }
  }

  private chord(notes: number[], t: number) {
    const { ctx, padFilter } = this.nodes!;
    const end = t + CHORD_LEN + 2.5;
    for (const n of notes) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.045, t + 2.8);
      g.gain.setValueAtTime(0.045, t + CHORD_LEN - 0.5);
      g.gain.exponentialRampToValueAtTime(0.0001, end);
      g.connect(padFilter);
      for (const detune of [-7, 7]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = mtof(n);
        osc.detune.value = detune;
        osc.connect(g);
        osc.start(t);
        osc.stop(end + 0.1);
      }
    }
    // A soft sub under the chord root.
    const sub = ctx.createOscillator();
    const sg = ctx.createGain();
    sub.frequency.value = mtof(notes[0] - 12);
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.06, t + 3);
    sg.gain.exponentialRampToValueAtTime(0.0001, end);
    sub.connect(sg).connect(padFilter);
    sub.start(t);
    sub.stop(end + 0.1);
  }

  private pluck(t: number) {
    const { ctx, out, send } = this.nodes!;
    // A gentle random walk over the scale sounds more like a melody than pure chance.
    this.lastNote = Math.max(0, Math.min(SCALE.length - 1, this.lastNote + Math.round((Math.random() - 0.5) * 4)));
    const lift = this.intensity > 0.7 && Math.random() < 0.4 ? 12 : 0;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = mtof(SCALE[this.lastNote] + lift);
    const g = ctx.createGain();
    const peak = 0.05 + this.intensity * 0.05;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    osc.connect(g);
    g.connect(out);
    g.connect(send);
    osc.start(t);
    osc.stop(t + 1.5);
  }
}

export const music = new Music();
