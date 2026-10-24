# Development ideas

No moving traffic (decided earlier). Game stays browser-only.

## Gameplay
- [ ] Combat depth: more weapons (chain, bat, kick), per-weapon damage and reach, block/dodge
- [ ] Cops: chase and bust mechanic, fines, escape
- [ ] Progression: career mode with money, bike shop, upgrades (engine, tyres, armour), repair costs
- [ ] Bike health: rash riding (hard crashes, wall scrapes, hits, drifting abuse) lowers bike health; lower health cuts max speed. Repair in bike shop (ties to career mode)
- [ ] Rival AI: rubber-banding tuning, named rivals with personality, grudge system
- [ ] Race modes: time trial with ghost, elimination, single-lap sprint
- [ ] Hazards: oil, potholes, road works, animals, fallen branches (static or scripted, not traffic)

## Tracks and world
- [ ] More tracks: night, rain, desert, coastal, snow (reuse biome and hills system)
- [x] Weather: rain and snowfall (visual only; start screen step 2)
- [ ] Weather handling: wet-road and snow grip, lower top speed and looser control in rain, winter and at night (bikes currently handle the same in every season and time of day)
- [ ] Fog weather
- [x] Day/night, headlights, lit street lamps (start screen step 2)
- [x] Winter: snow cover on scenery; road only 30% dusted so the track stays readable
- [ ] Shortcuts and branching paths
- [x] Roadside life: spectators (rider model, random shirts and trousers) at start and finish, billboards
- [ ] Roadside life: bridges, tunnels
- [ ] Hills tuning for city and Switchback Pass, rock cuts, guard rails on drops

## Visual and feel
- [ ] Sound: engine pitch by gear, wind, tyre screech, crash, music (check what exists)
- [ ] Particles: dust, sparks, tyre smoke, skid marks
- [ ] Camera: speed FOV, shake, crash cam, replay
- [ ] Post effects: motion blur, bloom, sun glare, scenery LOD
- [ ] Rider: more outfits, helmet colours, bike skins

## Technical
- [ ] Perf: measure on low-end laptop and phone, instancing audit, texture budget, load time
- [ ] Mobile: touch controls, gamepad support
- [ ] Settings menu: quality, key rebinding, volume
- [ ] Save data in localStorage: progress and best times
- [ ] CI running tsc, build, sim:race, sim:falls, sim:flow; fix flaky `sim:flow`
- [ ] Deploy to static host (GitHub Pages); PR/merge `city` stack into `main`

## Online (optional, breaks browser-only simplicity)
- [ ] Leaderboards, shared ghosts

## Suggested order
1. Sound + particles
2. Career / upgrades
3. Weather track

## Housekeeping
- [ ] Look at Switchback Pass start and Daredevil river approach on screen (fixes verified headless only)
- [ ] Open PR(s) for `scenery` and `city` branches
- [ ] Delete redundant local branches `hills`, `rider-lod`
- [ ] Decide fate of untracked `scenery1.png`, `scenery2.png`, `scenery3.png`
