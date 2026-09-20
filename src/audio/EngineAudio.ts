/**
 * Synthesised engine and wind noise — no audio files, so this needs nothing
 * sourced or bundled and can't fall out of sync with the physics.
 *
 * The engine is three detuned oscillators through a low-pass filter whose
 * cutoff opens with throttle. That combination is what separates "engine"
 * from "sine wave": a real engine's *timbre* changes under load, not just its
 * pitch, so a filter that opens when you're on the gas does more for
 * believability than any amount of oscillator stacking. Frequency tracks the
 * simulated gearbox's rpm, so upshifts drop the note audibly.
 *
 * Wind is a looped white-noise buffer through a low-pass that opens with
 * speed, mixed in proportion to speed squared (drag noise really does rise
 * roughly that way). It also usefully masks the synthetic edge of the
 * oscillators at high speed.
 *
 * Browsers refuse to start an AudioContext without a user gesture, so this
 * builds its graph immediately but stays silent until the first key press or
 * click resumes it. Every method is safe to call before that happens, and the
 * whole class degrades to a no-op if Web Audio is unavailable.
 */

/** Engine firing frequency, in Hz, at idle and at the redline. */
const FIRING_HZ_IDLE = 22;
const FIRING_HZ_REDLINE = 190;

const FILTER_HZ_CLOSED = 320;
const FILTER_HZ_OPEN = 3200;

/** Seconds for a parameter to approach a new value — long enough to avoid zipper noise. */
const PARAM_GLIDE = 0.03;

export class EngineAudio {
  private readonly context: AudioContext | null;
  private readonly master: GainNode | null = null;
  private readonly engineGain: GainNode | null = null;
  private readonly engineFilter: BiquadFilterNode | null = null;
  private readonly oscillators: OscillatorNode[] = [];
  private readonly windGain: GainNode | null = null;
  private readonly windFilter: BiquadFilterNode | null = null;

  private started = false;
  private volume = 0.2;
  private muted = false;
  private paused = false;

  constructor() {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      console.warn("[audio] Web Audio unavailable; running silent.");
      this.context = null;
      return;
    }

    const context = new Ctor();
    this.context = context;

    this.master = context.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(context.destination);

    // --- engine ---
    this.engineFilter = context.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = FILTER_HZ_CLOSED;
    this.engineFilter.Q.value = 3;

    this.engineGain = context.createGain();
    this.engineGain.gain.value = 0;

    this.engineFilter.connect(this.engineGain).connect(this.master);

    // Three voices an octave apart, slightly detuned. The detune is what stops
    // them phase-locking into one thin tone.
    for (const spec of [
      { type: "sawtooth" as OscillatorType, ratio: 1, detune: 0, level: 1 },
      { type: "square" as OscillatorType, ratio: 2.01, detune: 7, level: 0.45 },
      { type: "sawtooth" as OscillatorType, ratio: 0.5, detune: -5, level: 0.8 },
    ]) {
      const osc = context.createOscillator();
      osc.type = spec.type;
      osc.frequency.value = FIRING_HZ_IDLE * spec.ratio;
      osc.detune.value = spec.detune;
      const level = context.createGain();
      level.gain.value = spec.level;
      osc.connect(level).connect(this.engineFilter);
      osc.start();
      // Ratio is stashed on the node so `update` can retune all three from one rpm.
      (osc as OscillatorNode & { ratio: number }).ratio = spec.ratio;
      this.oscillators.push(osc);
    }

    // --- wind ---
    this.windFilter = context.createBiquadFilter();
    this.windFilter.type = "lowpass";
    this.windFilter.frequency.value = 400;

    this.windGain = context.createGain();
    this.windGain.gain.value = 0;
    this.windFilter.connect(this.windGain).connect(this.master);

    const noise = context.createBufferSource();
    noise.buffer = createNoiseBuffer(context);
    noise.loop = true;
    noise.connect(this.windFilter);
    noise.start();

    this.installGestureUnlock();
  }

  /** Browsers start the context suspended; the first real interaction resumes it. */
  private installGestureUnlock(): void {
    const context = this.context;
    if (!context) return;
    if (context.state === "running") {
      this.started = true;
      return;
    }
    const unlock = (): void => {
      void context.resume().then(() => {
        this.started = true;
      });
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("pointerdown", unlock);
    };
    window.addEventListener("keydown", unlock);
    window.addEventListener("pointerdown", unlock);
  }

  get isRunning(): boolean {
    return this.started && this.context?.state === "running";
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.applyMasterGain();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMasterGain();
  }

  /**
   * Silences the engine while the game is paused. Kept separate from
   * `setMuted` so pausing doesn't clobber the player's own mute setting, and
   * unpausing doesn't un-mute something they deliberately turned off.
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.applyMasterGain();
  }

  private applyMasterGain(): void {
    if (!this.context || !this.master) return;
    this.master.gain.setTargetAtTime(
      this.muted || this.paused ? 0 : this.volume,
      this.context.currentTime,
      PARAM_GLIDE,
    );
  }

  /**
   * @param rpmNormalized 0..1 between idle and redline, from the transmission.
   * @param throttle      0..1 — how hard the engine is being asked to work.
   * @param speedRatio    0..1 of estimated top speed, for wind.
   */
  update(rpmNormalized: number, throttle: number, speedRatio: number): void {
    const context = this.context;
    if (!context || !this.engineFilter || !this.engineGain || !this.windFilter || !this.windGain) return;
    if (context.state !== "running") return;

    const rpm = clamp01(rpmNormalized);
    const gas = clamp01(throttle);
    const speed = clamp01(speedRatio);
    const now = context.currentTime;

    const firingHz = FIRING_HZ_IDLE + (FIRING_HZ_REDLINE - FIRING_HZ_IDLE) * rpm;
    for (const osc of this.oscillators) {
      const ratio = (osc as OscillatorNode & { ratio: number }).ratio;
      osc.frequency.setTargetAtTime(firingHz * ratio, now, PARAM_GLIDE);
    }

    // Cutoff opens with rpm *and* throttle: at the same revs, on the gas is
    // brighter and harder than coasting. This is most of the "load" feel.
    const cutoff = FILTER_HZ_CLOSED + (FILTER_HZ_OPEN - FILTER_HZ_CLOSED) * (0.55 * rpm + 0.45 * gas);
    this.engineFilter.frequency.setTargetAtTime(cutoff, now, PARAM_GLIDE);

    const engineLevel = 0.06 + 0.15 * gas + 0.05 * rpm;
    this.engineGain.gain.setTargetAtTime(engineLevel, now, PARAM_GLIDE);

    this.windFilter.frequency.setTargetAtTime(350 + 2800 * speed, now, PARAM_GLIDE);
    this.windGain.gain.setTargetAtTime(0.14 * speed * speed, now, PARAM_GLIDE);
  }

  /**
   * Short percussive burst for a landed hit: filtered noise with a fast decay.
   * Built per call and left to garbage-collect once it has finished — these
   * are rare enough that pooling them would be premature.
   */
  playImpact(strength: number): void {
    const context = this.context;
    if (!context || !this.master || context.state !== "running") return;

    const now = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = createNoiseBuffer(context);
    source.loop = true;

    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    // Heavier hits land lower and read as more solid.
    filter.frequency.value = clamp(900 - strength * 260, 220, 900);
    filter.Q.value = 1.2;

    const gain = context.createGain();
    const peak = Math.min(0.5, 0.18 + strength * 0.16);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

    source.connect(filter).connect(gain).connect(this.master);
    source.start(now);
    source.stop(now + 0.25);
  }

  dispose(): void {
    for (const osc of this.oscillators) osc.stop();
    void this.context?.close();
  }
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Two seconds of white noise, long enough that the loop point isn't audible as a pulse. */
function createNoiseBuffer(context: AudioContext): AudioBuffer {
  const length = context.sampleRate * 2;
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
