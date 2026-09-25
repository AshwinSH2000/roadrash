# TODO

## ⏳ Waiting on you: rider downloads from Mixamo

Nothing on the rider can be built until these exist. Everything goes in
`public/assets/rider/`, as FBX straight from the download dialog.

- [ ] Sign in at **https://www.mixamo.com/** (free Adobe account)
- [ ] **Characters** tab → pick one (realistic human; *Y Bot* is fine for a first test; a racer if there is one)
      → **Download**: *FBX Binary · T-pose · With Skin* → save as **`rider.fbx`**
- [ ] **Animations** tab → search each, click to apply to your character
      → **Download**: *FBX Binary · Without Skin · 30 fps · Keyframe Reduction: none*

  | Save as      | Search for                                        |
  | ------------ | ------------------------------------------------- |
  | `ride.fbx`   | *Driving* (any seated pose)                       |
  | `idle.fbx`   | *Idle*                                            |
  | `getup.fbx`  | *Getting Up* / *Stand Up* (from lying on the ground) |
  | `run.fbx`    | *Running*                                         |
  | `punch.fbx`  | *Punching* (a single jab)                         |
  | `kick.fbx`   | *Kicking*                                         |

- [ ] `npm run check:rider` and paste the output

**Minimum to get a rider on the bike:** `rider.fbx` + `ride.fbx`. The rest can follow.

## Pending your look in the browser

- [ ] **The Wall** on Hillclimb (`?track=Hillclimb`): 30% over 120 m, then the drop. Flat out it's a jump at the crest and a flight off the top of the drop. Stop on it and you can still climb out. Crazy enough?
- [ ] **Your nitro jump off the Wall** (4 Sep) — the bounce and the "nonsense handling" on landing are fixed: the landing is absorbed instead of hitting the chassis, the nose stays pointed down the road while airborne, and the front wheel now finds the road on the drop (see PROGRESS.md). Your log is a regression test (`npm run sim:replay`, `npm run sim:climb`). Try it again, nitro lit at the foot: it should land at ~125 km/h, straight, and carry on down.
- [ ] **Six courses now**, random each load — Ridgeway (original), Switchback Pass, Long Sweeps, Hillclimb, The Esses, and **Drag Race** (new, requested directly: two miles, dead straight, no corners at all — a good place to feel out manual transmission's gears one at a time without a corner to worry about). Reload a few times; the HUD names it. Force one with `?track=Hillclimb` or `?track=DragRace` on the URL. Which ones are fun, which aren't?
- [ ] **New engine sound + gears that actually sound different (requested directly: "not liking the audio", "all gear shifts sound @ the same rpm").** Still fully synthesised, no audio files — but the four engine voices now run through a soft-saturation stage for a grittier, more modern edge, a short shift "cut" (a gain duck plus a click) fires on every real gear change, punchier and slightly slower in a low gear than a high one and different again between an upshift and a downshift, and the sustained note's own detune spread and filter resonance now drift with gear (wider/grittier low, tighter/cleaner high) so gears sound distinct even between shifts, not just at the instant of one. Can't be tuned by ear on this end — how's it sound now, and does each gear genuinely feel different?
- [ ] **Camera turns around when you finish (requested directly).** Cross the line and the chase cam flips to the bike's front side, looking back down the track at the finish line, so you can watch who finishes next instead of staring at empty road. Flips back for "Race Again". Does the framing read right, and is the flip itself jarring or does it settle in smoothly?
- [ ] **Minimap, top-right, square, rebuilt to match what you actually wanted (first version was a straight-line schematic — corrected directly).** It's now the real road curve for roughly the next/previous 200 m, redrawn every frame rotated so your current heading always points straight up — when the road bends, the ribbon and the other riders swing around you rather than you moving on the map. You stay fixed at the exact centre (larger dot); everyone else is a dot in their own cone colour. Road in grey. Take a corner and watch it turn under you — does the rotation read right, is 200 m the right amount of road to show, and is the square big enough to be useful without being in the way?

- [ ] **Nitro**: press **N** at speed. Bar bottom-left — green ready, orange boosting (5 s), grey recharging (20 s). Does +20 km/h feel like enough of a kick?

- [ ] The long left-hander spin — **root cause found and fixed** (pitch-locked chassis on the 8% climb put the front on its bump stop and the rear at half load; the suspension now follows the grade — see PROGRESS.md). Your brief twitch there now replays at 2° slip. Try the corner again, throttle on and off. Telemetry keeps logging to `logs/`; **M** marks a moment; `npm run sim:replay latest` replays the newest log.

- [ ] Phase 5 — ragdoll: **X** knocks you off, **Z** knocks off the nearest rival. Does the tumble look right at speed?
- [ ] Phase 6 — combat: **P** punch, **K** kick. Range and timing feel right?
- [ ] **Phase 7 — the bots fight now.** Watch the pack: they should trade a punch or a kick every 20–30 s, not constantly, and never at you. Bot hits log as `[Phase 7]` in the console. Does it read as opportunistic, or as a brawl?
- [ ] **"Bots attack you" switch** — bottom-right, **off by default**; tick it (or load with `?botsAttack=1`) and rivals alongside will come for you. Flip it mid-race; the HUD `bots` line reads it back. Is a hit every ~40 s with it on too much, too little?
- [ ] **Combat range + a fair-warning stand-off (requested directly: hits were landing from too far apart, and instantly on contact).** Punch's reach is down to 1.6 m and kick's to 2.1 m (from 2.3/3.0), so a rider has to be genuinely alongside, not just in the neighbourhood. And a bot no longer swings the moment it draws level: it now has to hold (cumulative, not necessarily unbroken) alongside position for a random 2-5 s stand-off first — real time to notice someone closing in and pull away before anything is thrown. Ride alongside a bot and see if you can react to the wind-up in time; watch the pack too, since the same rule applies bot-to-bot.
- [ ] **Phase 8 — the game has a front door now.** Start screen (pick Low/Medium/High and a course, or leave it Random), 3-2-1-GO with the pack held on the grid, a real HUD (position, clock, order, progress bar, speed), and an end screen — **You win / Finished Nth / Did not finish** — with **Race again** (Enter) and **Change settings**. Race again a few times in a row; does anything look wrong after a restart? The old debug readout (surface, off-centre, rpm, the bots switch) is hidden until you press **H** in dev.
- [ ] **DNF rule**: the race ends 3× the winner's time after they finish (6 min hard cap). Park on the grid and wait, or just ride slowly — the HUD warns "DNF in N s" in the last minute. Is 3× generous enough?
- [ ] **Phase 9 — visual polish.** Road and off-road now have a procedurally generated (not sourced) tiled texture instead of a flat fill; trees and rocks are scattered past the off-road band on both sides, density set by the quality preset (`sceneryDensity`: 0.3 low / 0.6 medium / 1.0 high); "High" now also runs a post-processing pass (bloom + SSAO) that "Low"/"Medium" skip entirely. No new asset files — see `src/render/Textures.ts`'s comment for why. Dropped from the original plan: real motion blur (needs a velocity buffer; judged not worth the machinery against a fixed-timestep game that already interpolates its render transform). Reload a few times on each preset — does Low still look reasonable, does High's bloom/SSAO actually read as nicer rather than just heavier, does the scenery ever look like it's floating (see the World edge note below for why it might, at the outer edge of what's modelled)?
- [ ] **Ground fill and clouds (requested directly: "apart from the roads and the greenery it is mostly blue").** Two more grass-textured bands run from the off-road edge out to 500 m either side — visual only, no collider — so the horizon and the view to the sides stop being flat sky-colour. A few dozen sprite clouds (procedurally drawn, not sourced) are scattered over the course too, count scaling with the same `sceneryDensity`. Does the ground now read as continuous out to the fog, or does the seam at the off-road edge show? Do the clouds look right at a normal chase-cam angle, and is the count about right on each preset?
- [ ] **Manual transmission (requested directly).** A third choice on the start screen, Automatic/Manual, next to graphics quality — Automatic is the default and is unchanged. In Manual: 6 real gears, **Q** downshifts, **E** upshifts, **T** switches manual ⇄ automatic mid-race (like **O** for autopilot). Each gear now genuinely caps your speed at its own redline — the bar bottom-centre next to the gear number shows engine speed as a percentage, amber past ~85%, red at the limiter — and you have to shift up to keep accelerating. Lower gears pull noticeably harder off the line; downshifting too far below your actual speed fights back with real engine braking rather than just being ignored, so a panic downshift costs you speed instead of gaining you any. Bots never use manual — only the player can. Things to feel out: do the six gears feel meaningfully different from each other, does downshift engine-braking feel fair or punishing, is Q/E comfortable next to WASD, is the redline cue (the amber/red percentage) readable at speed without staring at it?

## Next development phases (no assets needed)

- [ ] **Phase 10 — Feel/balance pass.**

## Pending your look in the browser (new)

- [ ] **World boundary + zoned scenery (requested directly: farms/animals, mountains, buildings, and a city crowd + parked cars watching, with an invisible wall so no one falls off the edge again).** An invisible wall now runs both sides of every course right at the 30 m off-road edge — stops the bike and a ragdoll rider cold instead of letting them fall through into the void (this fixes the "World edge" issue below). Each course also now has roadside-scenery zones instead of one uniform tree/rock scatter: Ridgeway gets a small town at the start/finish, Switchback Pass and the Hillclimb's Wall/drop read as mountain (bigger rocks, tall pines), Long Sweeps is farmland (cows, sheep, the odd barn), and The Esses is a town street with a crowd and cars lined up right behind the new wall, plus a couple of rows of houses/apartments further back. A low-poly mountain range now also sits on the far horizon on every course. Everything's still procedural shapes (boxes, cones, a capsule for people) in the existing low-poly style — nothing sourced. Ride off-road toward the edge and confirm you *can't* fall through any more; reload a few times per course to see each biome read distinctly; check the crowd/cars/buildings on Ridgeway and The Esses look right from the chase cam and don't clip the boundary wall; confirm the Hillclimb Wall jump still feels the same (regression-tested headlessly, but worth your own look).
- [ ] **Gradient sky + a visible "cliff" past the wall (requested directly: "there is just emptiness... same sky blue as the sky... is this sky or water or just some undeveloped portion of the game").** Two fixes: (1) the flat single-colour sky is now a cheap gradient dome (darker blue overhead, paling toward the horizon — one extra low-poly sphere and a tiny shader, no texture, no measurable cost), so sky reads as sky rather than as the same flat fill as everything else; (2) on any stretch where the road runs well above the course's lowest point, there used to be nothing rendered between the off-road edge and the flat ground-fill plane far below it — literally a hole showing sky through it, close to the player and low in the frame, which is almost certainly what read as "is this water/undeveloped." A textured rock/dirt "cliff" skirt now fills that gap exactly, following the terrain height at every point (tall on a climb, thin at the lowest point), right where the invisible wall already stops you. Reload a couple of courses, especially Hillclimb and Ridgeway (the two with the most elevation change) — look sideways/down past the wall on a climb and confirm you now see rock/dirt falling away rather than a blue gap; check the sky itself looks like a sky rather than a flat wall of colour, including at speed and through a jump.

## Known, not blocking

- Bundle is 2.9 MB (Three + Rapier + loaders + the new post-processing passes); a code-splitting pass later.
- High-speed falls hit the 6 s force-settle timeout rather than the velocity test.
- Six identical CB750s — only the coloured cone tells riders apart. A per-rider paint tint would help once the rider exists.
- Bots have no nitro yet (Phase 10, tuned against aggression).
- "Change settings" on the end screen reloads the page (the renderer is built from the quality preset once). Fine for v1.
- A remounted rider very occasionally sits stuck on the road for 4 s and is rescued — probably facing backwards into the wrong-way block. Fall system, Phase 10.
