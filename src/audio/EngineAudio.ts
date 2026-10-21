/**
 * Synthesised engine and wind noise — no audio files, so this needs nothing
 * sourced or bundled and can't fall out of sync with the physics.
 *
 * The engine is four detuned oscillators, summed and driven through a soft
 * saturation curve before the low-pass filter — the saturation is what was
 * missing for a "modern" sportbike edge (requested directly): a clean sum of
 * oscillators reads as a synth pad no matter how it's filtered, but pushing
 * that sum into gentle clipping adds the harmonic grit a real high-revving
 * engine has, especially under load. The filter's own cutoff still opens
 * with throttle, which is what separates "engine" from "sine wave" in the
 * first place — a real engine's *timbre* changes under load, not just its
 * pitch.
 *
 * Requested directly, also: every gear used to sound identical, because the
 * only thing that changed at a shift was the smoothed pitch continuously
 * chasing the new target. Two things now make gears actually distinguishable:
 * a short percussive "shift cut" fires on every real gear change (`update`'s
 * `gear` argument, compared frame to frame) — a brief gain duck plus a
 * filtered click, punchier and slightly slower on a low gear (more inertia
 * to interrupt), quicker and lighter on a high one, and different again
 * between an upshift and a downshift — and the running tone's own detune
 * spread and filter resonance drift with gear, wider/grittier low, tighter
 * and cleaner high, so even away from a shift the gears don't sound
 * interchangeable.
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
const FIRING_HZ_REDLINE = 210;

const FILTER_HZ_CLOSED = 320;
const FILTER_HZ_OPEN = 3200;

/** Gain on the effects bus relative to the engine mix, which is left untouched. */
const SFX_BOOST = 2.6;
/** Extra gain on kick, punch, fall and screech over the rest of the effects bus. */
const COMBAT_BOOST = 3;

/** Seconds for a parameter to approach a new value — long enough to avoid zipper noise. */
const PARAM_GLIDE = 0.03;

/**
 * The four voices making up the engine note: a fundamental, an octave-up
 * "whine", a sub for body, and a thin high "bite". The bite voice's `level`
 * is nominal only — its actual gain is driven separately, by throttle and
 * rpm together (`update`'s `biteGain`), so it only shows up under load
 * rather than sitting at a fixed level even at idle.
 */
const ENGINE_VOICES: readonly { type: OscillatorType; ratio: number; detune: number; level: number }[] = [
  { type: "sawtooth", ratio: 1, detune: 0, level: 1 },
  { type: "square", ratio: 2.01, detune: 7, level: 0.45 },
  { type: "sawtooth", ratio: 0.5, detune: -5, level: 0.8 },
  { type: "square", ratio: 4.02, detune: 4, level: 0.16 },
];
/** Index into `ENGINE_VOICES` of the "bite" voice — gained separately, by throttle and rpm together, rather than at a fixed level like the other three. */
const BITE_VOICE_INDEX = 3;

/** This game's transmission is fixed at 6 gears (`Transmission.ts`); kept here as a plain number rather than an import so audio stays decoupled from the gearbox model, exactly as it always has been. */
const GEAR_COUNT = 6;

export class EngineAudio {
  private readonly context: AudioContext | null;
  private readonly master: GainNode | null = null;
  private readonly engineGain: GainNode | null = null;
  private readonly engineFilter: BiquadFilterNode | null = null;
  private readonly engineShaper: WaveShaperNode | null = null;
  /** Ducked and restored on a shift; never touched by the continuous per-frame level, which targets `engineGain` instead — two separate gain stages so the two don't fight over the same parameter. */
  private readonly shiftDuck: GainNode | null = null;
  private readonly oscillators: (OscillatorNode & { ratio: number; baseDetune: number })[] = [];
  private readonly biteGain: GainNode | null = null;
  private readonly windGain: GainNode | null = null;
  private readonly windFilter: BiquadFilterNode | null = null;
  /** Bus for kick/punch/fall/victory/screech: boosted above the engine, through a limiter so the boost can't clip. */
  private readonly sfxBus: GainNode | null = null;
  private readonly combatBus: GainNode | null = null;
  private readonly skidGain: GainNode | null = null;
  private readonly skidFilter: BiquadFilterNode | null = null;

  private started = false;
  private volume = 0.2;
  private muted = false;
  private paused = false;
  private lastGear = 1;

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
    this.engineShaper = context.createWaveShaper();
    this.engineShaper.curve = makeSaturationCurve(0.55);
    this.engineShaper.oversample = "2x";

    this.engineFilter = context.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = FILTER_HZ_CLOSED;
    this.engineFilter.Q.value = 3;

    this.shiftDuck = context.createGain();
    this.shiftDuck.gain.value = 1;

    this.engineGain = context.createGain();
    this.engineGain.gain.value = 0;

    this.engineShaper.connect(this.engineFilter).connect(this.shiftDuck).connect(this.engineGain).connect(this.master);

    // Four voices — see `ENGINE_VOICES`. Detune is what stops them
    // phase-locking into one thin tone, and is itself re-tuned per gear in
    // `update` (wider apart in a low gear, tighter in a high one).
    const engineMix = context.createGain();
    engineMix.gain.value = 1;
    engineMix.connect(this.engineShaper);

    for (let i = 0; i < ENGINE_VOICES.length; i++) {
      const spec = ENGINE_VOICES[i];
      const osc = context.createOscillator() as OscillatorNode & { ratio: number; baseDetune: number };
      osc.type = spec.type;
      osc.frequency.value = FIRING_HZ_IDLE * spec.ratio;
      osc.detune.value = spec.detune;
      // Ratio and base detune are stashed on the node so `update` can
      // retune/redetune all four from one rpm and one gear.
      osc.ratio = spec.ratio;
      osc.baseDetune = spec.detune;

      const level = context.createGain();
      // Gained separately by throttle*rpm in `update` rather than fixed —
      // the "bite" should only really show up under load, not idling, so it
      // starts silent rather than at `spec.level`.
      level.gain.value = i === BITE_VOICE_INDEX ? 0 : spec.level;
      osc.connect(level).connect(engineMix);
      if (i === BITE_VOICE_INDEX) this.biteGain = level;

      osc.start();
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

    this.sfxBus = context.createGain();
    this.sfxBus.gain.value = SFX_BOOST;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = 0;
    limiter.knee.value = 4;
    limiter.ratio.value = 6;
    this.sfxBus.connect(limiter).connect(this.master);
    this.combatBus = context.createGain();
    this.combatBus.gain.value = COMBAT_BOOST;
    this.combatBus.connect(this.sfxBus);

    // --- tyre screech: looped noise through a narrow band-pass, silent until `setSkid` ---
    this.skidFilter = context.createBiquadFilter();
    this.skidFilter.type = "bandpass";
    this.skidFilter.frequency.value = 1500;
    this.skidFilter.Q.value = 7;

    this.skidGain = context.createGain();
    this.skidGain.gain.value = 0;
    this.skidFilter.connect(this.skidGain).connect(this.combatBus);

    const skidNoise = context.createBufferSource();
    skidNoise.buffer = createNoiseBuffer(context);
    skidNoise.loop = true;
    skidNoise.connect(this.skidFilter);
    skidNoise.start();

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
   * @param gear          1-based gear number. A change from the previous call
   *                      fires the shift cut; the current value also colours
   *                      the running tone (detune spread, filter resonance).
   */
  update(rpmNormalized: number, throttle: number, speedRatio: number, gear = 1): void {
    const context = this.context;
    if (!context || !this.engineFilter || !this.engineGain || !this.windFilter || !this.windGain) return;
    if (context.state !== "running") return;

    if (gear !== this.lastGear) {
      this.triggerShiftCut(gear, gear > this.lastGear);
      this.lastGear = gear;
    }

    const rpm = clamp01(rpmNormalized);
    const gas = clamp01(throttle);
    const speed = clamp01(speedRatio);
    const now = context.currentTime;

    // 0 at 1st gear, 1 at top — the one number every per-gear timbre tweak
    // below is derived from.
    const gearT = clamp01((gear - 1) / (GEAR_COUNT - 1));

    const firingHz = FIRING_HZ_IDLE + (FIRING_HZ_REDLINE - FIRING_HZ_IDLE) * rpm;
    // Wider apart in a low gear (grittier, torquier), tighter in a high one
    // (cleaner, more of a scream) — this is what keeps a gear's *sustained*
    // note distinguishable from its neighbours, not just the shift moment.
    const detuneScale = 1.6 - gearT * 0.6;
    for (const osc of this.oscillators) {
      osc.frequency.setTargetAtTime(firingHz * osc.ratio, now, PARAM_GLIDE);
      osc.detune.setTargetAtTime(osc.baseDetune * detuneScale, now, PARAM_GLIDE);
    }

    // Cutoff opens with rpm *and* throttle: at the same revs, on the gas is
    // brighter and harder than coasting. This is most of the "load" feel.
    const cutoff = FILTER_HZ_CLOSED + (FILTER_HZ_OPEN - FILTER_HZ_CLOSED) * (0.55 * rpm + 0.45 * gas);
    this.engineFilter.frequency.setTargetAtTime(cutoff, now, PARAM_GLIDE);
    // A touch more resonant snarl in the lower gears.
    this.engineFilter.Q.setTargetAtTime(2.4 + (1 - gearT) * 2.0, now, PARAM_GLIDE);

    const engineLevel = 0.06 + 0.15 * gas + 0.05 * rpm;
    this.engineGain.gain.setTargetAtTime(engineLevel, now, PARAM_GLIDE);

    // The "bite" voice: near-silent off-throttle at any rpm, present only
    // when both revs and load are up — the extra rasp a modern inline-4
    // gets right before it hits the limiter.
    if (this.biteGain) {
      const bite = Math.max(0, rpm - 0.35) * gas * 0.5;
      this.biteGain.gain.setTargetAtTime(bite, now, PARAM_GLIDE);
    }

    this.windFilter.frequency.setTargetAtTime(350 + 2800 * speed, now, PARAM_GLIDE);
    this.windGain.gain.setTargetAtTime(0.14 * speed * speed, now, PARAM_GLIDE);
  }

  /**
   * The audible "shift" — a brief gain duck (on `shiftDuck`, never
   * `engineGain`, which `update` is already gliding every frame and would
   * otherwise cut this ramp short one frame later) plus a short filtered
   * click. Punchier and a little slower on a low gear, quick and light on a
   * high one; a downshift reads lower/duller than an upshift, matching the
   * different engine-braking "thunk" a real one has.
   */
  private triggerShiftCut(gear: number, upshift: boolean): void {
    const context = this.context;
    if (!context || !this.shiftDuck || context.state !== "running") return;
    const now = context.currentTime;
    const gearT = clamp01((gear - 1) / (GEAR_COUNT - 1));

    const duckDepth = upshift ? 0.8 - gearT * 0.35 : 0.55 - gearT * 0.2;
    const duckSeconds = ((upshift ? 55 : 85) - gearT * 20) / 1000;
    this.shiftDuck.gain.cancelScheduledValues(now);
    this.shiftDuck.gain.setValueAtTime(1, now);
    this.shiftDuck.gain.linearRampToValueAtTime(1 - duckDepth, now + duckSeconds * 0.4);
    this.shiftDuck.gain.linearRampToValueAtTime(1, now + duckSeconds);

    this.playShiftClick(gearT, upshift);
  }

  private playShiftClick(gearT: number, upshift: boolean): void {
    const context = this.context;
    if (!context || !this.master) return;
    const now = context.currentTime;

    const source = context.createBufferSource();
    source.buffer = createNoiseBuffer(context);

    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = upshift ? 1200 + gearT * 700 : 420 - gearT * 120;
    filter.Q.value = 5;

    const gain = context.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.22, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);

    source.connect(filter).connect(gain).connect(this.master);
    source.start(now);
    source.stop(now + 0.09);
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

  /**
   * Tyre screech while braking hard or sliding. `intensity` is 0..1; 0 fades
   * it out. Pitch rises a little with intensity, and a slow wobble keeps the
   * noise from sounding like a steady hiss.
   */
  setSkid(intensity: number): void {
    const context = this.context;
    if (!context || !this.skidGain || !this.skidFilter || context.state !== "running") return;
    const level = clamp01(intensity);
    const now = context.currentTime;
    this.skidGain.gain.setTargetAtTime(level * 0.16, now, level > 0 ? 0.03 : 0.08);
    this.skidFilter.frequency.setTargetAtTime(1300 + level * 700 + Math.sin(now * 23) * 90, now, 0.02);
  }

  /** Kick: a heavier thud with a low body and a short dull slap. `gain` is 0..1, for distance falloff. */
  playKick(gain = 1): void {
    this.playThump(gain, 95, 0.5, 700, 0.3);
  }

  /** Punch: a snappier, higher, shorter smack. */
  playPunch(gain = 1): void {
    this.playThump(gain, 150, 0.34, 1800, 0.14);
  }

  /** A low sine drop (the body) under a short filtered noise burst (the slap). */
  private playThump(gain: number, bodyHz: number, peak: number, slapHz: number, seconds: number): void {
    const context = this.context;
    if (!context || !this.combatBus || context.state !== "running" || gain <= 0.01) return;
    const now = context.currentTime;

    const body = context.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(bodyHz * 1.8, now);
    body.frequency.exponentialRampToValueAtTime(bodyHz * 0.5, now + seconds);
    const bodyGain = context.createGain();
    bodyGain.gain.setValueAtTime(peak * gain, now);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
    body.connect(bodyGain).connect(this.combatBus);
    body.start(now);
    body.stop(now + seconds + 0.02);

    const slap = context.createBufferSource();
    slap.buffer = createNoiseBuffer(context);
    const slapFilter = context.createBiquadFilter();
    slapFilter.type = "bandpass";
    slapFilter.frequency.value = slapHz;
    slapFilter.Q.value = 0.9;
    const slapGain = context.createGain();
    slapGain.gain.setValueAtTime(peak * 0.9 * gain, now);
    slapGain.gain.exponentialRampToValueAtTime(0.0001, now + seconds * 0.5);
    slap.connect(slapFilter).connect(slapGain).connect(this.combatBus);
    slap.start(now);
    slap.stop(now + seconds * 0.5 + 0.02);
  }

  /**
   * A rider tumbling along the road. Real body impacts are dull and noisy,
   * not tonal, so each one is a low-passed noise burst (the soft-body slap)
   * over a short low "thump" with only a small pitch drop. They come at
   * uneven, shortening gaps and fade as the body loses energy, with every
   * pitch and level randomised per fall so no two sound alike. A quiet cloth
   * and gravel drag runs underneath.
   */
  playFall(gain = 1, delay = 0.1): void {
    const context = this.context;
    if (!context || !this.combatBus || context.state !== "running" || gain <= 0.01) return;
    const rand = (min: number, max: number): number => min + Math.random() * (max - min);

    let t = context.currentTime + delay;
    let energy = 1;
    let gap = rand(0.2, 0.3);
    const bounces = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < bounces; i++) {
      const level = energy * gain;

      const slap = context.createBufferSource();
      slap.buffer = createNoiseBuffer(context);
      const slapFilter = context.createBiquadFilter();
      slapFilter.type = "lowpass";
      slapFilter.frequency.value = rand(300, 700) * (0.6 + energy * 0.4);
      const slapGain = context.createGain();
      slapGain.gain.setValueAtTime(0.0001, t);
      slapGain.gain.linearRampToValueAtTime(0.55 * level, t + 0.006);
      slapGain.gain.exponentialRampToValueAtTime(0.0001, t + rand(0.09, 0.15));
      slap.connect(slapFilter).connect(slapGain).connect(this.combatBus);
      slap.start(t, Math.random());
      slap.stop(t + 0.18);

      const hz = rand(55, 90);
      const thump = context.createOscillator();
      thump.type = "sine";
      thump.frequency.setValueAtTime(hz * 1.25, t);
      thump.frequency.exponentialRampToValueAtTime(hz, t + 0.07);
      const thumpGain = context.createGain();
      thumpGain.gain.setValueAtTime(0.0001, t);
      thumpGain.gain.linearRampToValueAtTime(0.4 * level, t + 0.008);
      thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      thump.connect(thumpGain).connect(this.combatBus);
      thump.start(t);
      thump.stop(t + 0.14);

      t += gap;
      gap *= rand(0.65, 0.85);
      energy *= rand(0.5, 0.7);
    }

    const drag = context.createBufferSource();
    drag.buffer = createNoiseBuffer(context);
    const dragFilter = context.createBiquadFilter();
    dragFilter.type = "bandpass";
    dragFilter.frequency.setValueAtTime(900, context.currentTime + delay);
    dragFilter.frequency.exponentialRampToValueAtTime(350, t + 0.3);
    dragFilter.Q.value = 0.7;
    const dragGain = context.createGain();
    dragGain.gain.setValueAtTime(0.0001, context.currentTime + delay);
    dragGain.gain.linearRampToValueAtTime(0.1 * gain, context.currentTime + delay + 0.1);
    dragGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    drag.connect(dragFilter).connect(dragGain).connect(this.combatBus);
    drag.start(context.currentTime + delay, Math.random());
    drag.stop(t + 0.32);
  }

  /** Air swish for a strike swinging, hit or miss: band-passed noise that rises then falls. A kick is lower and longer than a punch. */
  playWhoosh(isKick: boolean, gain = 1): void {
    const context = this.context;
    if (!context || !this.combatBus || context.state !== "running" || gain <= 0.01) return;
    const now = context.currentTime;
    const seconds = isKick ? 0.26 : 0.18;
    const centre = isKick ? 700 : 1200;

    const source = context.createBufferSource();
    source.buffer = createNoiseBuffer(context);
    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 1.1;
    filter.frequency.setValueAtTime(centre * 0.6, now);
    filter.frequency.exponentialRampToValueAtTime(centre * 1.6, now + seconds * 0.55);
    filter.frequency.exponentialRampToValueAtTime(centre * 0.8, now + seconds);
    const env = context.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(0.3 * gain, now + seconds * 0.5);
    env.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
    source.connect(filter).connect(env).connect(this.combatBus);
    source.start(now, Math.random());
    source.stop(now + seconds + 0.02);
  }

  /** Victory fanfare: a rising major arpeggio ending on a held chord, then a cheer-like noise swell. */
  playVictory(): void {
    const context = this.context;
    if (!context || !this.sfxBus || context.state !== "running") return;
    const now = context.currentTime;

    // C5 E5 G5 C6, then C major held.
    const notes: [number, number, number][] = [
      [523.25, 0, 0.14],
      [659.25, 0.13, 0.14],
      [783.99, 0.26, 0.14],
      [1046.5, 0.39, 0.9],
      [659.25, 0.39, 0.9],
      [783.99, 0.39, 0.9],
    ];
    for (const [hz, offset, length] of notes) {
      const t = now + offset;
      const osc = context.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = hz;
      const env = context.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(0.16, t + 0.02);
      env.gain.setValueAtTime(0.16, t + length * 0.6);
      env.gain.exponentialRampToValueAtTime(0.0001, t + length + 0.25);
      osc.connect(env).connect(this.sfxBus);
      osc.start(t);
      osc.stop(t + length + 0.3);
    }

    const cheer = context.createBufferSource();
    cheer.buffer = createNoiseBuffer(context);
    const cheerFilter = context.createBiquadFilter();
    cheerFilter.type = "bandpass";
    cheerFilter.frequency.value = 1800;
    cheerFilter.Q.value = 0.6;
    const cheerGain = context.createGain();
    cheerGain.gain.setValueAtTime(0.0001, now + 0.35);
    cheerGain.gain.linearRampToValueAtTime(0.1, now + 0.6);
    cheerGain.gain.exponentialRampToValueAtTime(0.0001, now + 2.0);
    cheer.connect(cheerFilter).connect(cheerGain).connect(this.sfxBus);
    cheer.start(now + 0.35);
    cheer.stop(now + 2.05);
  }

  /** Start-light amber: three short beeps. */
  playBlip(): void {
    for (let i = 0; i < 3; i++) this.playBeep(880, 0.12, i * 0.6);
  }

  /** Start-light green: one long, higher beep. */
  playGoBeep(): void {
    this.playBeep(1320, 0.8);
  }

  private playBeep(hz: number, seconds: number, delay = 0): void {
    const context = this.context;
    if (!context || !this.sfxBus || context.state !== "running") return;
    const now = context.currentTime + delay;
    const osc = context.createOscillator();
    osc.type = "square";
    osc.frequency.value = hz;
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = hz * 3;
    const env = context.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(0.1, now + 0.008);
    env.gain.setValueAtTime(0.1, now + seconds - 0.03);
    env.gain.linearRampToValueAtTime(0.0001, now + seconds);
    osc.connect(filter).connect(env).connect(this.sfxBus);
    osc.start(now);
    osc.stop(now + seconds + 0.02);
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

/**
 * A `WaveShaperNode` curve for gentle, symmetric soft-clip saturation — the
 * harmonic grit that separates a "modern engine" from a clean sum of
 * oscillators (requested directly). `amount` is 0..~1; higher pushes more of
 * the waveform into the curve's shoulder.
 */
function makeSaturationCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(new ArrayBuffer(n * Float32Array.BYTES_PER_ELEMENT));
  const k = 1 + amount * 12;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}
