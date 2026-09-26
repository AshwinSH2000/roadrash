# Road Rash — Browser Edition

A full-contact motorcycle combat racer for the browser, in the spirit of the
mid-90s Road Rash games: race six riders down a point-to-point course, and
punch or kick the ones next to you off their bikes while you're at it.

Runs entirely client-side — no install, no backend, no account. Open it in a
browser and race.

**Play it now:** [roadrashreturns.netlify.app](https://roadrashreturns.netlify.app)

## What's in it

- **Six riders, one road** — you plus five AI opponents, each with their own
  driving personality (aggression, cornering confidence, line preference).
- **Full-contact combat** — punch and kick riders alongside you; landed hits
  knock them off into a physics-driven ragdoll tumble, and they get back up,
  run to their bike, and rejoin the race. Bots fight each other and, if you
  opt in, you too.
- **Manual or automatic transmission** — automatic just works; manual gives
  you 6 real gears, each with its own redline that caps your speed until you
  shift up, and a downshift too far below your speed fights back with real
  engine braking.
- **Nitro** — a one-shot speed boost on a recharge timer.
- **Six courses**, picked at random each race or forced with `?track=Name`:
  Ridgeway, Switchback Pass, Long Sweeps, Hillclimb (with "the Wall" — a 30%
  grade climb and matching drop), The Esses, and Drag Race (two miles, dead
  straight, no corners at all).
- **A rotating minimap** — the real local road curve, always pointing your
  current heading straight up.
- **Three quality presets** (Low/Medium/High) trading off shadows, scenery
  density, draw distance, and post-processing.

Everything you see and hear is generated in code — procedural terrain
textures, synthesized engine audio, low-poly scenery (trees, farms,
mountains, a city crowd watching from behind a barrier) — nothing sourced or
downloaded at runtime.

## Playing it

```
npm install
npm run dev
```

Open the URL Vite prints. Pick your graphics quality, transmission, and
course (or leave it random) on the start screen, then race.

For a static build (what actually ships — no server needed to serve it):

```
npm run build   # outputs to dist/
npm run preview # serve the build locally to check it
```

### Testing on a phone

Touch and tilt controls (steer by tilting the device, on-screen throttle/
brake/punch/kick/nitro) kick in automatically on any touch device — nothing
to configure. To try them on your own phone against the dev server:

```
mkcert -install
mkdir -p .certs
mkcert -cert-file .certs/dev-cert.pem -key-file .certs/dev-key.pem localhost 127.0.0.1 <your-lan-ip>
npm run dev
```

`vite.config.ts` picks up `.certs/` automatically and serves HTTPS on your
LAN (`https://<your-lan-ip>:5173`) — needed because iOS only grants the tilt
permission over a secure connection. No certs present, and the server just
falls back to plain HTTP for desktop use.

### Controls

| Key         | Action                                    |
| ----------- | ------------------------------------------ |
| W / ↑       | Throttle                                   |
| S / ↓       | Brake                                      |
| A / D, ← / →| Steer                                      |
| P           | Punch                                      |
| K           | Kick                                       |
| N           | Nitro                                      |
| Q / E       | Shift down / up (manual transmission only) |
| T           | Toggle manual ⇄ automatic transmission     |
| O           | Toggle autopilot (AI drives your bike)     |
| Space       | Pause                                      |
| H           | Toggle the dev debug readout (dev builds)  |

## Tech stack

- **Three.js** for rendering, **Rapier** (`@dimforge/rapier3d-compat`) for
  physics — an "arcade-sim hybrid" vehicle model: raycast suspension on two
  centreline wheels, a torque curve (or, in manual mode, a real per-gear one)
  rather than research-grade two-wheel dynamics.
- **TypeScript + Vite**. `vite build` produces a plain static site; Node/npm
  are only needed for development.
- No backend, no database, nothing persisted across a reload — this is a
  first development cycle, deliberately scoped down (see `PROGRESS.md`).

## Development

`TODO.md` is the running playtest checklist (what's pending a look/listen in
the browser); `PROGRESS.md` is the full development log, phase by phase,
including the reasoning behind non-obvious decisions and the bugs found
along the way.

The vehicle/combat/AI/track logic is covered by a suite of headless
simulations (no browser needed) rather than a conventional test framework —
run any of them with `npm run <name>`:

| Script          | Checks                                              |
| --------------- | ---------------------------------------------------- |
| `check:track`   | Every course's geometry against the track validator |
| `sim:race`      | A full AI-only race finishes cleanly                 |
| `sim:combat`    | Punch/kick range, arc, cooldown, knockback           |
| `sim:aicombat`  | AI combat behaviour, "bots attack you" setting       |
| `sim:manual`    | Manual transmission's per-gear physics               |
| `sim:climb`     | The Wall (Hillclimb) is climbable and landable       |
| `sim:flow`      | Start → finish → race again, repeatedly, no leaks    |
| `sim:falls`     | Ragdoll fall/recovery cycle                          |
| `sim:replay`    | Replays a recorded telemetry log against current physics |

(`node scripts/run-sim.mjs <name>` is what each of these wraps; see that
file for the full list.)

## Status

Personal hobby project, first development cycle — a deliberately trimmed
scope with an understanding that more maps/bikes/riders/persistence are
future additions once this core loop feels great. The rider is currently a
placeholder box pending Mixamo character/animation downloads (see `TODO.md`
if you're picking this back up).
