import * as THREE from "three";
import GUI from "lil-gui";
import { createSceneSetup, focusSunOn } from "../render/SceneSetup";
import { PhysicsWorld } from "../physics/PhysicsWorld";
import { SurfaceRegistry } from "../physics/TerrainMaterial";
import { FIXED_DT, FixedStepAccumulator } from "./Clock";
import { InputManager } from "./InputManager";
import { Bike } from "../entities/Bike";
import { PlayerController } from "../entities/PlayerController";
import { BrakeToStopDriver, Racer } from "../entities/Racer";
import { RiderStateMachine } from "../entities/RiderStateMachine";
import { AttackPhase, CombatSystem, type HitEvent } from "../combat/CombatSystem";
import { RaceFlow, RacePhase, RaceResult } from "./RaceFlow";
import { HUD, type HudStanding } from "../ui/HUD";
import { CountdownOverlay } from "../ui/CountdownOverlay";
import { EndScreen } from "../ui/EndScreen";
import type { StartChoice } from "../ui/StartScreen";
import { QUALITY_PRESETS } from "../settings/GraphicsSettings";
import { GRID_COLUMNS, GRID_ROWS, PLAYER_GRID_SLOT, gridPose } from "../track/StartGrid";
import { attackDuration, ATTACKS } from "../combat/AttackDefinitions";
import { ChaseCamera } from "../camera/ChaseCamera";
import { EngineAudio } from "../audio/EngineAudio";
import { TrackDefinition } from "../track/TrackDefinition";
import { pickTrack } from "../track/tracks";
import { buildTrack, type BuiltTrack } from "../track/TrackBuilder";
import { buildScenery } from "../track/Scenery";
import { buildClouds } from "../render/Sky";
import { createPostProcessing, type PostProcessing } from "../render/PostProcessing";
import { OpponentAI } from "../ai/OpponentAI";
import {
  CombatBehavior,
  DEFAULT_AI_COMBAT_SETTINGS,
  type AiCombatSettings,
} from "../ai/CombatBehavior";
import {
  AUTOPILOT_PERSONALITY,
  OPPONENT_PERSONALITIES,
  PLAYER_COLOR,
} from "../ai/RiderPersonality";
import { showFatalError } from "./ErrorOverlay";
import { Telemetry } from "./Telemetry";
import { Nitro } from "../entities/Nitro";
import { loadAssets, type LoadedAssets } from "./AssetLoader";
import {
  createPlaceholderBikeVisuals,
  makeGltfBikeVisualsFactory,
  DEFAULT_BIKE_FITTING,
  type BikeFitting,
  type BikeVisualsFactory,
} from "../entities/BikeVisuals";
import { LOCAL_RIGHT, WORLD_UP } from "../utils/Directions";

/**
 * Six riders on the point-to-point course — the player plus five AI opponents
 * that follow the racing line, brake for corners, move over for each other,
 * and now and then throw a punch at one another. Whether they may also come
 * for the player is an on-screen switch, off by default.
 *
 * The race itself — countdown, racing, the finish or the timeout, and "Race
 * Again" — is `RaceFlow`; this class owns the world it happens in and the
 * screens that show it (`ui/`).
 */

/** How far below the lowest point of the track a rider must fall to count as off the world. */
const VOID_FALL_MARGIN = 30;

/** Seconds after the start before the stuck-rider check arms, so a standing start isn't "stuck". */
const STUCK_GRACE_SECONDS = 3;

/** Seconds between the race ending and the end screen coming up — long enough to see the line crossed. */
const END_SCREEN_DELAY = 1.2;

/**
 * Impulse used by the debug knockdown keys, in newton-seconds.
 *
 * Sized against the torso it is applied to (about 26 kg), not against the
 * whole rider: 250 is a change of roughly 10 m/s at the point of impact,
 * which drags the rest of the body with it through the joints. The first
 * value tried here was 900, which works out to a 35 m/s kick — the rider was
 * fired off like a cannon shell, tumbled 200 m, and the fall told you nothing
 * about how fast the bike had been going. The impulse must stay small enough
 * that the rider's own momentum is what dominates.
 */
const DEBUG_KNOCKDOWN_IMPULSE = 250;

export class Game {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly physics: PhysicsWorld;
  /** Phase 9: bloom + SSAO, "high" preset only. Null means render straight to the canvas. */
  private readonly postProcessing: PostProcessing | null;

  private readonly surfaces = new SurfaceRegistry();
  private readonly track: TrackDefinition;
  private readonly builtTrack: BuiltTrack;

  private readonly input: InputManager;
  private readonly racers: Racer[] = [];
  private readonly player: Racer;
  /** Chassis collider handle -> rider, for resolving finish-line overlaps. */
  private readonly racerByCollider = new Map<number, Racer>();

  private readonly combat: CombatSystem;
  /**
   * Who the bots may hit. Shared by reference with every bot's
   * `CombatBehavior`, so flipping the on-screen switch takes effect on the
   * next decision without anything being rebuilt. `?botsAttack=1` on the URL
   * starts with it on, for testing.
   */
  private readonly aiCombatSettings: AiCombatSettings = { ...DEFAULT_AI_COMBAT_SETTINGS };
  private readonly playerController: PlayerController;
  private readonly playerAutopilot: OpponentAI;
  private autopilotEngaged = false;

  private readonly chaseCamera: ChaseCamera;
  private readonly engineAudio = new EngineAudio();

  private readonly accumulator = new FixedStepAccumulator();
  private readonly flow = new RaceFlow();
  private readonly hud: HUD;
  private readonly countdown = new CountdownOverlay();
  private readonly endScreen: EndScreen;
  /** Counts down from `END_SCREEN_DELAY` once the race ends; the screen shows at zero. */
  private endScreenTimer = -1;
  private readonly pauseOverlay: HTMLDivElement;

  private paused = false;
  /** Previous frame's spacebar state, for edge detection — see `step`. */
  private pauseKeyWasDown = false;

  private readonly tmpKnock = new THREE.Vector3();

  private finishedCount = 0;
  /**
   * Seconds since the lights went out — unlike `RaceFlow.raceElapsed`, this
   * keeps running after the player finishes or times out. `RaceFlow` freezes
   * its clock the instant the race is decided (correct for the player's own
   * displayed time and the HUD), but bots crossing the line afterward still
   * need their *own* finish time. Without this, every bot that finished
   * after the player was stamped with the player's own frozen time — a
   * DNF'd or third-place player made it look like the whole field crossed
   * the line in the same instant they did.
   */
  private raceClock = 0;
  private readonly voidFallY: number;

  private readonly assets: LoadedAssets;
  /** Dev-only 10 Hz log of the player's bike; see `Telemetry`. */
  private readonly telemetry: Telemetry | null;
  /** Player-only for now; bots get theirs with the AI combat/balance work. */
  private readonly nitro = new Nitro();
  /** One per bot, kept so a restart can clear their chases and cooldowns. */
  private readonly combatBehaviors: CombatBehavior[] = [];
  /** Live fitting numbers for the bike model; edited in the debug GUI, re-applied via `refitBikeModel`. */
  private readonly bikeFitting: BikeFitting = { ...DEFAULT_BIKE_FITTING };
  private bikeVisuals: BikeVisualsFactory = createPlaceholderBikeVisuals;

  private constructor(
    setup: ReturnType<typeof createSceneSetup>,
    physics: PhysicsWorld,
    assets: LoadedAssets,
    choice: StartChoice,
  ) {
    this.scene = setup.scene;
    this.camera = setup.camera;
    this.renderer = setup.renderer;
    this.sunLight = setup.sunLight;
    this.physics = physics;

    // The course from the start screen, or a random one; `?track=Name` on
    // the URL preselects it there.
    const query = new URLSearchParams(window.location.search);
    const layout = pickTrack(choice.track);
    this.aiCombatSettings.botsAttackPlayer = query.get("botsAttack") === "1";
    // `?autopilot=1` starts with the bike driving itself — dev only, for
    // watching a whole race (and its end screen) without a hand on the keys.
    const startOnAutopilot = import.meta.env.DEV && query.get("autopilot") === "1";
    this.track = new TrackDefinition(layout);
    console.info(`[track] "${layout.name}" — ${layout.description} (quality: ${choice.quality})`);
    this.builtTrack = buildTrack(this.physics, this.scene, this.track, this.surfaces);

    const quality = QUALITY_PRESETS[choice.quality];
    this.scene.add(buildScenery(this.track, quality).group);
    this.scene.add(buildClouds(this.track, quality).group);
    this.postProcessing = quality.postProcessing
      ? createPostProcessing(this.renderer, this.scene, this.camera)
      : null;
    window.addEventListener("resize", () => {
      this.postProcessing?.resize(window.innerWidth, window.innerHeight);
    });

    let lowest = Infinity;
    for (const p of this.track.samplePoints) lowest = Math.min(lowest, p.y);
    this.voidFallY = lowest - VOID_FALL_MARGIN;

    this.assets = assets;
    this.buildBikeVisualsFactory();

    this.input = new InputManager();
    this.player = this.createField();

    // Drivers are assigned only once every racer exists, because the AI needs
    // to see the whole field in order to avoid it, and combat needs it to find
    // targets.
    this.combat = new CombatSystem(this.racers, (hit) => this.onHit(hit));
    this.playerController = new PlayerController(
      this.input,
      this.player.bike,
      this.combat,
      this.player,
      this.nitro,
    );
    this.playerAutopilot = new OpponentAI(
      this.player,
      this.track,
      this.racers,
      AUTOPILOT_PERSONALITY,
    );
    this.player.baseDriver = this.playerController;
    this.player.driver = this.playerController;
    if (startOnAutopilot) this.setAutopilot(true);

    let personalityIndex = 0;
    for (const racer of this.racers) {
      if (racer.isPlayer) continue;
      const personality = OPPONENT_PERSONALITIES[personalityIndex++];
      const behavior = new CombatBehavior(racer, this.racers, this.combat, personality, this.aiCombatSettings);
      this.combatBehaviors.push(behavior);
      racer.baseDriver = new OpponentAI(racer, this.track, this.racers, personality, behavior);
      racer.driver = racer.baseDriver;
    }

    this.chaseCamera = new ChaseCamera(this.camera, this.physics);
    this.telemetry = import.meta.env.DEV ? new Telemetry(this.player, this.track, this.nitro) : null;
    if (this.telemetry) {
      console.info(`[telemetry] logging the player's bike at 10 Hz to logs/telemetry-${this.telemetry.session}.csv — press M to mark a moment`);
      window.addEventListener("beforeunload", () => void this.telemetry?.flush());
    }
    // The dev readout starts hidden even in dev — H brings it up. It sits
    // where the running order does, and the order is the thing to watch.
    this.hud = new HUD(false);
    this.endScreen = new EndScreen(
      () => this.restartRace(),
      // The renderer is built from the quality preset and never reconfigured
      // live, so "change settings" is a fresh page with the start screen.
      () => window.location.reload(),
    );
    this.pauseOverlay = this.createPauseOverlay();
    this.createSettingsPanel();

    if (import.meta.env.DEV) {
      this.setupDebugGui();
    }

    console.log(
      `[Phase 4] ${this.racers.length} riders on a ${this.track.raceLength.toFixed(0)}m race ` +
        `(${this.track.totalLength.toFixed(0)}m spline). Player starts P${PLAYER_GRID_SLOT + 1}. ` +
        `Space = pause, O = autopilot${import.meta.env.DEV ? ", H = dev readout" : ""}.`,
    );
    console.log(
      `[Phase 7] bots fight each other; bots attack you: ${this.aiCombatSettings.botsAttackPlayer ? "ON" : "off"} ` +
        `(switch top-right, or ?botsAttack=1).`,
    );

    window.requestAnimationFrame(this.tick);
  }

  static async bootstrap(container: HTMLElement, choice: StartChoice): Promise<Game> {
    const setup = createSceneSetup(container, QUALITY_PRESETS[choice.quality]);
    // Physics and assets are independent, so they load concurrently; assets
    // never reject, so this can't be the thing that stops the game starting.
    const [physics, assets] = await Promise.all([PhysicsWorld.create(), loadAssets()]);
    return new Game(setup, physics, assets, choice);
  }

  /**
   * Points `bikeVisuals` at the loaded model if there is one and it fits, and
   * at the placeholder otherwise.
   *
   * A model that fails to fit is reported and then ignored. That is deliberate:
   * the whole reason for loading assets separately from the game starting is so
   * that trying a candidate model costs nothing when it turns out to be
   * unsuitable — the race still runs, on boxes, with an explanation in the
   * console of exactly which node it couldn't find.
   */
  private buildBikeVisualsFactory(): void {
    if (!this.assets.has("rider")) {
      console.info(
        "[assets] no rider model yet — riders are invisible on the bike and capsules on foot. " +
          "Run `npm run check:rider` for the download steps (Mixamo, free), or see TODO.md.",
      );
    }
    const asset = this.assets.get("bike");
    if (!asset) {
      this.bikeVisuals = createPlaceholderBikeVisuals;
      return;
    }
    try {
      const { factory, report } = makeGltfBikeVisualsFactory(asset.scene, this.bikeFitting);
      this.bikeVisuals = factory;
      console.info(
        `[assets] bike model fitted via ${report.strategy}: ` +
          `wheelbase ${report.measuredWheelBase.toFixed(3)} model units -> scale x${report.autoScale.toFixed(4)}; ` +
          `heading ${report.headingDeg.toFixed(1)} deg corrected to +Z; ` +
          `wheel radius ${report.fittedWheelRadius.toFixed(3)}m vs ${report.expectedWheelRadius.toFixed(3)}m expected ` +
          `(a large gap here means the model's proportions differ from the physics bike).`,
      );
      if (report.strategy === "auto-split") {
        console.info(
          `[assets] the model had no per-wheel nodes, so ${report.splitTriangles} triangles were ` +
            `separated out of ${report.splitMeshes?.join(", ")} to make the wheels turn. ` +
            `Run \`npm run check:bike\` for the full fit report.`,
        );
        if (report.steering) {
          console.info(
            `[assets] steering assembly recovered: ${report.steering.parts} parts turn with the bars ` +
              `about a fork axis raked ${report.steering.rakeDeg.toFixed(1)} deg.`,
          );
        }
        if ((report.frontPoseDeg ?? 0) >= 0.5 || (report.rearPoseDeg ?? 0) >= 0.5) {
          console.info(
            `[assets] wheels were modelled off-axis (front ${report.frontPoseDeg?.toFixed(1)} deg, ` +
              `rear ${report.rearPoseDeg?.toFixed(1)} deg) and have been straightened.`,
          );
        }
      }
    } catch (error) {
      console.error(`[assets] bike model could not be fitted, using placeholder.\n${String(error)}`);
      this.bikeVisuals = createPlaceholderBikeVisuals;
    }
  }

  /** Re-fits the model and swaps every bike over to it, without touching the physics. */
  private refitBikeModel(): void {
    this.buildBikeVisualsFactory();
    for (const racer of this.racers) {
      racer.bike.setVisuals(this.bikeVisuals(racer.color));
    }
  }

  /** Builds the six-rider field on the starting grid (`StartGrid`), racers in slot order. */
  private createField(): Racer {
    let player: Racer | null = null;
    let personalityIndex = 0;

    for (let slot = 0; slot < GRID_COLUMNS * GRID_ROWS; slot++) {
      const pose = gridPose(this.track, slot);

      const isPlayer = slot === PLAYER_GRID_SLOT;
      const personality = isPlayer ? null : OPPONENT_PERSONALITIES[personalityIndex++];
      const color = personality?.color ?? PLAYER_COLOR;
      const name = personality?.name ?? "You";

      const bike = new Bike(
        this.physics,
        this.surfaces,
        this.scene,
        pose.position,
        pose.rotation,
        color,
        this.bikeVisuals,
      );
      const rider = new RiderStateMachine(this.physics, this.scene, bike, color);
      const racer = new Racer(bike, name, isPlayer, color, rider);
      racer.updateTrackPosition(this.track);

      this.racers.push(racer);
      this.racerByCollider.set(bike.controller.chassisCollider.handle, racer);
      if (isPlayer) player = racer;
    }

    if (!player) throw new Error(`PLAYER_GRID_SLOT ${PLAYER_GRID_SLOT} is outside the grid`);
    return player;
  }

  /**
   * Full-screen dim with a message, shown while paused. Sits above the HUD
   * but below lil-gui's own layer, so the tuning panel stays usable while the
   * world is frozen.
   */
  private createPauseOverlay(): HTMLDivElement {
    const overlay = document.createElement("div");
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "display:none",
      "align-items:center",
      "justify-content:center",
      "flex-direction:column",
      "gap:10px",
      "background:rgba(0,0,0,0.5)",
      "color:#fff",
      "font:600 44px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace",
      "letter-spacing:0.18em",
      "text-shadow:0 2px 12px rgba(0,0,0,0.6)",
      "pointer-events:none",
      "z-index:20",
    ].join(";");

    const title = document.createElement("div");
    title.textContent = "PAUSED";

    const hint = document.createElement("div");
    hint.textContent = "press spacebar to resume";
    hint.style.cssText = "font:400 15px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0.08em;opacity:0.85";

    overlay.append(title, hint);
    document.body.appendChild(overlay);
    return overlay;
  }

  /**
   * The one player-facing setting so far: whether the bots may come for you.
   * Off by default — the pack fights among itself and leaves the human alone
   * until you opt in. A real settings screen is Phase 8; this is a plain
   * checkbox so it can be flipped mid-race.
   */
  private createSettingsPanel(): void {
    const panel = document.createElement("div");
    panel.style.cssText = [
      "position:fixed",
      "right:12px",
      "bottom:24px",
      "padding:10px 14px",
      "font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace",
      "color:#fff",
      "background:rgba(0,0,0,0.45)",
      "border-radius:6px",
      "user-select:none",
      // Above lil-gui (1001), whose root container reaches down the right
      // edge in dev builds and would otherwise sit on top of the checkbox.
      "z-index:1002",
    ].join(";");

    const title = document.createElement("div");
    title.textContent = "SETTINGS";
    title.style.cssText = "font-size:12px;letter-spacing:0.08em;opacity:0.85;margin-bottom:6px";

    const label = document.createElement("label");
    label.style.cssText = "display:flex;align-items:center;gap:8px;cursor:pointer";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = this.aiCombatSettings.botsAttackPlayer;
    checkbox.style.cssText = "width:16px;height:16px;margin:0;cursor:pointer";
    const text = document.createElement("span");
    text.textContent = "Bots attack you";
    label.append(checkbox, text);

    const hint = document.createElement("div");
    hint.style.cssText = "font-size:11px;opacity:0.7;margin-top:4px";
    const describe = (): void => {
      hint.textContent = this.aiCombatSettings.botsAttackPlayer
        ? "on — rivals alongside may punch or kick you"
        : "off — bots only fight each other";
    };
    describe();

    checkbox.addEventListener("change", () => {
      this.aiCombatSettings.botsAttackPlayer = checkbox.checked;
      describe();
      // Give the keyboard back to the game: a focused checkbox would swallow
      // the spacebar (pause) and toggle itself instead.
      checkbox.blur();
      console.log(`[Phase 7] bots attack you: ${checkbox.checked ? "ON" : "off"}`);
    });

    panel.append(title, label, hint);
    document.body.appendChild(panel);
  }

  private setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.pauseOverlay.style.display = paused ? "flex" : "none";
    this.engineAudio.setPaused(paused);
  }

  /**
   * Riders ordered by race position: those who have finished, in the order
   * they finished, then everyone still running, by distance covered.
   */
  private standings(): Racer[] {
    return [...this.racers].sort((a, b) => {
      if (a.hasFinished && b.hasFinished) return a.finishPosition - b.finishPosition;
      if (a.hasFinished) return -1;
      if (b.hasFinished) return 1;
      return b.distanceAlong - a.distanceAlong;
    });
  }

  private updateHud(): void {
    const player = this.player;
    const controller = player.bike.controller;
    const speedKph = Math.abs(player.bike.forwardSpeed) * 3.6;
    const raced = player.distanceAlong - this.track.startDistance;

    const order = this.standings();
    const playerPosition = order.indexOf(player) + 1;
    const standings: HudStanding[] = order.map((racer) => ({
      name: racer.name,
      isPlayer: racer === player,
      hasFinished: racer.hasFinished,
      raceTime: racer.raceTime,
      gap: racer.distanceAlong - player.distanceAlong,
    }));

    const firstFinish = this.firstFinishTime();
    const combat = this.combat.snapshot(player);
    this.hud.update({
      trackName: this.track.name,
      speedKph,
      gear: controller.gear,
      position: playerPosition,
      fieldSize: this.racers.length,
      raceTime: this.flow.raceElapsed,
      progress: raced / this.track.raceLength,
      standings,
      nitro: { charge: this.nitro.charge, state: this.nitro.current },
      combat: combat.kind === null ? null : { kind: combat.kind, phase: combat.phase, cooldown: combat.cooldown },
      recovering: !player.rider.isRiding,
      secondsToDnf:
        this.flow.isRacing && firstFinish !== null
          ? this.flow.deadline(firstFinish) - this.flow.raceElapsed
          : null,
    });

    if (this.hud.debugVisible) {
      this.hud.setDebugText(
        [
          `surface   ${controller.surfaceName}`,
          `off-centre${player.lateralOffset >= 0 ? " +" : " "}${player.lateralOffset.toFixed(1)}m`,
          `rpm       ${controller.rpm.toFixed(0).padStart(5)}${this.engineAudio.isRunning ? "" : "   (audio: press a key)"}`,
          `rider     ${player.rider.current}`,
          `race      ${this.flow.current}`,
          this.autopilotEngaged ? "O         AUTOPILOT — press O to take back over" : "O         autopilot",
          "X/Z       knock off self / nearest rival",
          `bots      fight each other; attack you: ${this.aiCombatSettings.botsAttackPlayer ? "ON" : "off"}`,
          ...(this.telemetry
            ? [
                `telemetry ${this.telemetry.lastError ? "ERROR " + this.telemetry.lastError : `${this.telemetry.rowsWritten} rows`}` +
                  `  M = mark`,
              ]
            : []),
          "H         hide this readout",
        ].join("\n"),
      );
    }
  }

  /** Race time of the first rider across the line, or null while nobody has finished. */
  private firstFinishTime(): number | null {
    let first: number | null = null;
    for (const racer of this.racers) {
      if (racer.hasFinished && (first === null || racer.raceTime < first)) first = racer.raceTime;
    }
    return first;
  }

  private setupDebugGui(): void {
    const gui = new GUI({ title: "Vehicle Tuning (dev only)" });
    const cfg = this.player.bike.controller.tuning;
    const applyWheelTuning = (): void => this.player.bike.controller.applyWheelTuning();

    const raceProxy = { autopilot: false };
    const race = gui.addFolder("Race");
    race
      .add(raceProxy, "autopilot")
      .name("player on autopilot (O)")
      .onChange((v: boolean) => this.setAutopilot(v))
      .listen();

    const drivetrain = gui.addFolder("Drivetrain");
    drivetrain.add(cfg, "maxEngineForce", 500, 8000, 50);
    drivetrain.add(cfg, "brakeForce", 2, 60, 1);
    drivetrain.add(cfg, "engineBrakeForce", 0, 20, 0.5).name("engine braking (lift-off)");
    drivetrain.add(cfg, "topSpeedEstimate", 10, 80, 1);
    drivetrain.add(cfg, "reverseTolerance", 0, 3, 0.1);
    drivetrain.close();

    const steerProxy = {
      maxSteerAngleDeg: THREE.MathUtils.radToDeg(cfg.maxSteerAngle),
      steerSpeedDeg: THREE.MathUtils.radToDeg(cfg.steerSpeed),
      steerSpeedAtTopSpeedDeg: THREE.MathUtils.radToDeg(cfg.steerSpeedAtTopSpeed),
    };
    const steering = gui.addFolder("Steering");
    steering
      .add(steerProxy, "maxSteerAngleDeg", 5, 60, 1)
      .name("lock at standstill")
      .onChange((v: number) => (cfg.maxSteerAngle = THREE.MathUtils.degToRad(v)));
    // The main knob for high-speed feel: lower = wider, calmer corners.
    steering.add(cfg, "maxLateralAccel", 4, 30, 0.5).name("cornering g-limit");
    steering.add(cfg, "maxYawRate", 0.3, 3, 0.05).name("max turn rate (rad/s)");
    steering
      .add(steerProxy, "steerSpeedDeg", 30, 720, 5)
      .name("bar rate (slow)")
      .onChange((v: number) => (cfg.steerSpeed = THREE.MathUtils.degToRad(v)));
    steering
      .add(steerProxy, "steerSpeedAtTopSpeedDeg", 10, 400, 5)
      .name("bar rate (fast)")
      .onChange((v: number) => (cfg.steerSpeedAtTopSpeed = THREE.MathUtils.degToRad(v)));

    const suspension = gui.addFolder("Suspension & Grip");
    suspension.add(cfg, "suspensionStiffness", 5, 100, 1).onChange(applyWheelTuning);
    suspension.add(cfg, "suspensionDamping", 0.1, 10, 0.1).onChange(applyWheelTuning);
    suspension.add(cfg, "sideFrictionStiffness", 0.1, 3, 0.05).onChange(applyWheelTuning);
    // Grip itself comes from whichever surface each wheel is on; this scales
    // both surfaces together so tuning it doesn't erase the road/off-road gap.
    suspension.add(cfg, "gripMultiplier", 0.2, 2.5, 0.05);
    suspension.add(cfg, "loadCompensationMax", 1, 5, 0.1).name("grip vs wheel load (1=off)");
    suspension.add(cfg, "slipRecoveryTorque", 0, 12000, 100).name("slide recovery");
    suspension.add(cfg, "slipRecoveryMaxTorque", 0, 8000, 100).name("slide recovery cap");
    suspension.add(cfg, "gradeFollowing", 0, 1, 0.05).name("follow grade (0=off)");
    suspension.close();

    const cam = this.chaseCamera.tuning;
    const camera = gui.addFolder("Chase Camera");
    camera.add(cam, "followDistance", 2, 14, 0.1).name("distance");
    camera.add(cam, "extraDistanceAtSpeed", 0, 8, 0.1).name("+ distance at speed");
    camera.add(cam, "followHeight", 0.5, 8, 0.1).name("height");
    camera.add(cam, "lookAheadAtSpeed", 0, 20, 0.5).name("look ahead at speed");
    camera.add(cam, "positionSmoothTime", 0.02, 0.8, 0.01).name("follow lag (s)");
    camera.add(cam, "fovAtSpeed", 60, 110, 1).name("FOV at speed");
    camera.add(cam, "rollFraction", 0, 1, 0.05).name("roll with lean");
    camera.close();

    // Only worth showing when there is a model to fit; with the placeholder
    // these numbers have nothing to act on.
    if (this.assets.has("bike")) {
      const fit = this.bikeFitting;
      const refit = (): void => this.refitBikeModel();
      const model = gui.addFolder("Bike Model Fitting");
      model.add(fit, "scaleAdjust", 0.2, 3, 0.01).name("scale x").onChange(refit);
      model.add(fit, "yawOffsetDeg", -180, 180, 15).name("yaw offset").onChange(refit);
      model.add(fit, "offsetX", -1, 1, 0.01).name("shift right/left").onChange(refit);
      model.add(fit, "offsetY", -1, 1, 0.01).name("shift up/down").onChange(refit);
      model.add(fit, "offsetZ", -1, 1, 0.01).name("shift fore/aft").onChange(refit);
      model.close();
    }

    const audioProxy = { volume: 0.2, muted: false };
    const audio = gui.addFolder("Audio");
    audio.add(audioProxy, "volume", 0, 1, 0.01).onChange((v: number) => this.engineAudio.setVolume(v));
    audio.add(audioProxy, "muted").onChange((v: boolean) => this.engineAudio.setMuted(v));
    audio.close();
  }

  /**
   * Debug-only knockdown, so the fall/recovery cycle can be exercised before
   * combat exists to trigger it. Sideways-and-up, which is what a punch from
   * an adjacent rider will produce in the next phase.
   */
  private debugKnockDown(racer: Racer | null): void {
    if (!racer || !racer.rider.isRiding) return;
    this.tmpKnock
      .copy(LOCAL_RIGHT)
      .applyQuaternion(racer.bike.worldQuaternion)
      .multiplyScalar(DEBUG_KNOCKDOWN_IMPULSE)
      .addScaledVector(WORLD_UP, DEBUG_KNOCKDOWN_IMPULSE * 0.35);
    racer.rider.knockOff(this.tmpKnock);
    console.log(
      `[Phase 5] ${racer.name} knocked off at ` +
        `${(Math.abs(racer.bike.forwardSpeed) * 3.6).toFixed(0)} km/h.`,
    );
  }

  /** Closest still-racing opponent to the player, for the debug knockdown key. */
  private nearestOpponent(): Racer | null {
    let best: Racer | null = null;
    let bestDistance = Infinity;
    for (const racer of this.racers) {
      if (racer.isPlayer || racer.hasFinished) continue;
      const distance = racer.bike.worldPosition.distanceTo(this.player.bike.worldPosition);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = racer;
      }
    }
    return best;
  }

  /** Reports a landed hit — a sound, and a line in the console for tuning. */
  private onHit(hit: HitEvent): void {
    this.engineAudio.playImpact(hit.impulse / ATTACKS[hit.kind].knockback);
    console.log(
      `[${hit.attacker.isPlayer ? "Phase 6" : "Phase 7"}] ${hit.attacker.name} ${hit.kind}ed ${hit.victim.name} off ` +
        `(impulse ${hit.impulse.toFixed(0)}, closing ${hit.closingSpeed.toFixed(1)} m/s).`,
    );
  }

  /** Drives each rider's strike indicator from their combat state. */
  private syncStrikeVisuals(): void {
    for (const racer of this.racers) {
      const snapshot = this.combat.snapshot(racer);
      if (snapshot.phase === AttackPhase.IDLE || snapshot.kind === null) {
        racer.bike.setStrike(0, 0);
        continue;
      }
      const definition = ATTACKS[snapshot.kind];
      const total = attackDuration(definition);
      const progress = 1 - snapshot.cooldown / total;
      // Punch out through wind-up and the live window, pull back through
      // recovery — so what you see matches when the strike can actually land.
      const strikeEnd = (definition.windup + definition.active) / total;
      const extension =
        progress <= strikeEnd
          ? progress / strikeEnd
          : Math.max(0, 1 - (progress - strikeEnd) / (1 - strikeEnd));
      // Before a target is picked, `side` is 0; throw on the side the rider
      // is leaning toward so the wind-up reads as intent.
      const side = snapshot.side !== 0 ? snapshot.side : racer.bike.leanAngle >= 0 ? 1 : -1;
      racer.bike.setStrike(side, 0.35 + extension * (definition.range * 0.35));
    }
  }

  private setAutopilot(engaged: boolean): void {
    this.autopilotEngaged = engaged;
    this.player.baseDriver = engaged ? this.playerAutopilot : this.playerController;
    // A finished rider's bike is braking to a stop; leave that driver alone.
    if (!this.player.hasFinished) this.player.driver = this.player.baseDriver;
  }

  /**
   * "Race Again": everyone back on the grid, on their bikes, with nothing
   * remembered — attacks in progress, chases, cooldowns, the nitro bar, the
   * finishing order — and the countdown started. No bodies are created or
   * destroyed here (a ragdoll mid-fall is despawned by the remount), which
   * is what `npm run sim:flow` checks.
   */
  private restartRace(): void {
    for (let slot = 0; slot < this.racers.length; slot++) {
      const racer = this.racers[slot];
      const pose = gridPose(this.track, slot);
      racer.restart(pose.position, pose.rotation, this.track);
    }
    this.combat.resetAll();
    for (const behavior of this.combatBehaviors) behavior.reset();
    this.nitro.reset();
    this.player.bike.controller.setBoost(false);
    this.finishedCount = 0;
    this.raceClock = 0;
    this.endScreenTimer = -1;
    this.endScreen.hide();
    this.flow.restart();
    this.setPaused(false);
    console.log("[Phase 8] race restarted — everyone back on the grid.");
  }

  /** The race just ended for the player: log it, and queue the end screen. */
  private onRaceEnd(): void {
    const result = this.flow.outcome;
    // On a timeout the player is still riding; take the bike off them the
    // same way the finish line does, so the world winds down behind the
    // screen instead of carrying on with a ghost at the controls.
    if (result === RaceResult.DNF) this.player.driver = new BrakeToStopDriver(this.player.bike);
    this.endScreenTimer = END_SCREEN_DELAY;
    console.log(
      `[Phase 8] race over: ${result} — P${this.flow.position} of ${this.racers.length} ` +
        `at ${this.flow.raceElapsed.toFixed(2)}s.`,
    );
  }

  private showEndScreen(): void {
    const result = this.flow.outcome;
    if (result === null) return;
    this.endScreen.show({
      result,
      position: this.flow.position,
      fieldSize: this.racers.length,
      raceTime: result === RaceResult.DNF ? this.flow.raceElapsed : this.player.raceTime,
      standings: this.endScreenStandings(),
    });
  }

  private endScreenStandings(): { name: string; isPlayer: boolean; hasFinished: boolean; raceTime: number }[] {
    return this.standings().map((racer) => ({
      name: racer.name,
      isPlayer: racer === this.player,
      hasFinished: racer.hasFinished,
      raceTime: racer.raceTime,
    }));
  }

  /**
   * Puts a rider back on the road. Used both for falling off the world and
   * for sitting motionless — the phase's verification requires that no bot
   * ends up permanently stuck, and with no combat yet there is nothing else
   * that could free one.
   */
  private rescue(racer: Racer, reason: string): void {
    // Never rescue to before the start line — there's road there, but a rider
    // put too far back would have wheels hanging off the end of the ribbon.
    const rescueDistance = THREE.MathUtils.clamp(
      racer.distanceAlong - 5,
      this.track.startDistance,
      this.track.finishDistance,
    );
    racer.bike.teleport(
      this.track.spawnPoint(rescueDistance, 0, 1.5),
      this.track.spawnRotation(rescueDistance),
    );
    // A rider mid-fall would otherwise be left standing in a field while
    // their bike teleports away from them.
    if (!racer.rider.isRiding) racer.rider.forceRemount();
    racer.resetProjection();
    console.warn(
      `[Phase 4] ${racer.name} ${reason}; recovered to ${rescueDistance.toFixed(0)}m along the track.`,
    );
  }

  /**
   * Polls the finish sensor for every rider at once. The per-rider
   * `hasFinished` guard is what makes this fire exactly once each — a sensor
   * reports an overlap on every step a body is inside it, not just the step
   * it entered.
   */
  private checkFinish(): void {
    if (this.finishedCount >= this.racers.length) return;
    this.physics.world.intersectionPairsWith(this.builtTrack.finishSensor, (other) => {
      const racer = this.racerByCollider.get(other.handle);
      if (!racer || racer.hasFinished) return;
      racer.finishRace(this.raceClock, ++this.finishedCount);
      console.log(
        `[Phase 4] P${racer.finishPosition}  ${racer.name}  ${racer.raceTime.toFixed(2)}s`,
      );
    });
  }

  private readonly tick = (now: number): void => {
    // An exception here would otherwise stop the loop being rescheduled and
    // leave a frozen, rendered frame on screen with no visible error — which
    // reads as "the controls stopped working" rather than as a crash.
    try {
      this.step(now);
    } catch (error) {
      showFatalError("Crashed during the game loop", error);
      return;
    }
    window.requestAnimationFrame(this.tick);
  };

  private step(now: number): void {
    // Edge-detected here rather than through `InputManager.wasJustPressed`,
    // because that flag is cleared by `endStep()` inside the fixed-step loop —
    // which doesn't run while paused (so the key would never clear and the
    // game would immediately unpause), and doesn't run at all on a frame with
    // zero physics steps (so one press could toggle twice).
    const pauseKeyDown = this.input.isDown("Space");
    if (pauseKeyDown && !this.pauseKeyWasDown) this.setPaused(!this.paused);
    this.pauseKeyWasDown = pauseKeyDown;

    if (this.paused) {
      // Still drain the accumulator, so the time spent paused isn't banked up
      // and replayed as a burst of physics steps the moment we resume.
      this.accumulator.beginFrame(now);
      this.render();
      return;
    }

    const steps = this.accumulator.beginFrame(now);

    for (let i = 0; i < steps; i++) {
      if (this.input.wasJustPressed("KeyO")) this.setAutopilot(!this.autopilotEngaged);
      if (this.input.wasJustPressed("KeyX")) this.debugKnockDown(this.player);
      if (this.input.wasJustPressed("KeyZ")) this.debugKnockDown(this.nearestOpponent());
      if (this.input.wasJustPressed("KeyM")) this.telemetry?.mark();
      if (import.meta.env.DEV && this.input.wasJustPressed("KeyH")) this.hud.toggleDebug();

      const phase = this.flow.current;
      if (phase === RacePhase.COUNTDOWN) {
        // Bikes sit on the grid with the engines idling and the brakes on:
        // physics runs so the suspension settles, but nobody — player or
        // bot — gets the controls, and nobody rolls if the grid is on a grade.
        for (const racer of this.racers) {
          racer.rider.tick(FIXED_DT);
          racer.bike.setInput(0, 0);
          racer.bike.controller.setHandbrake(true);
        }
      } else {
        for (const racer of this.racers) racer.bike.controller.setHandbrake(false);
        // The bar drains and refills on its own clock, whatever the rider is
        // doing — braking, or even lying in the grass. Only the *effect* is
        // gated on riding, via the controller ignoring boost without throttle.
        this.nitro.tick(FIXED_DT);
        for (const racer of this.racers) racer.tickDriver(FIXED_DT);
        this.player.bike.controller.setBoost(this.nitro.isActive);
      }
      this.combat.tick(FIXED_DT);
      for (const racer of this.racers) racer.bike.prePhysicsStep(FIXED_DT);
      this.physics.step();
      for (const racer of this.racers) racer.bike.postPhysicsStep();
      this.input.endStep();

      for (const racer of this.racers) racer.updateTrackPosition(this.track);
      if (phase !== RacePhase.COUNTDOWN) {
        this.raceClock += FIXED_DT;
        const graceElapsed = this.flow.raceElapsed > STUCK_GRACE_SECONDS;
        // Track positions are current for this step; sampling before the
        // update would be one step stale, which at 10 Hz is invisible.
        this.telemetry?.tick(FIXED_DT);
        for (const racer of this.racers) {
          if (racer.hasFinished) continue;
          if (racer.bike.worldPosition.y <= this.voidFallY) {
            this.rescue(racer, "fell off the world");
          } else if (racer.updateStuck(FIXED_DT, graceElapsed)) {
            this.rescue(racer, "was stuck");
          }
        }
        this.checkFinish();
      }

      const order = this.standings();
      const ended = this.flow.tick(FIXED_DT, {
        playerFinished: this.player.hasFinished,
        playerPosition: order.indexOf(this.player) + 1,
        firstFinishTime: this.firstFinishTime(),
        fieldSize: this.racers.length,
      });
      if (ended) this.onRaceEnd();
      if (this.endScreenTimer > 0) {
        this.endScreenTimer -= FIXED_DT;
        if (this.endScreenTimer <= 0) this.showEndScreen();
      }
    }

    const frameDelta = this.accumulator.frameDelta;
    for (const racer of this.racers) {
      racer.bike.syncRender(this.accumulator.alpha, frameDelta);
      racer.rider.syncRender();
    }
    // The camera watches the rider, not the bike, once they've been thrown off.
    this.chaseCamera.update(this.player.bike, this.player.rider.cameraPosition, frameDelta);
    focusSunOn(this.sunLight, this.player.rider.cameraPosition);
    this.syncStrikeVisuals();
    this.updateAudio();
    this.updateHud();
    if (this.flow.current === RacePhase.FINISHED) {
      this.countdown.hide();
      this.endScreen.updateStandings(this.endScreenStandings());
    } else {
      this.countdown.update(this.flow.countdown, this.flow.raceElapsed);
    }

    this.render();
  }

  /** Routes through the Phase 9 post-processing chain when it's built, straight to the canvas otherwise. */
  private render(): void {
    if (this.postProcessing) this.postProcessing.render();
    else this.renderer.render(this.scene, this.camera);
  }

  private updateAudio(): void {
    const controller = this.player.bike.controller;
    if (!this.player.rider.isRiding) {
      this.engineAudio.update(0, 0, 0);
      return;
    }
    const speedRatio = Math.abs(this.player.bike.forwardSpeed) / controller.tuning.topSpeedEstimate;
    this.engineAudio.update(
      controller.rpmNormalized,
      Math.max(0, controller.debugInputs.throttle),
      speedRatio,
    );
  }
}
