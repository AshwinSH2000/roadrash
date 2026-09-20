# Dropping in a bike model

Put a file called **`bike.glb`** in this folder and reload. That's the whole
installation step. Delete it and the game goes back to the boxes.

Nothing here is committed or required — an empty folder is a valid state, and
the game starts normally either way.

## What the file has to satisfy

**`.glb`, not `.gltf`.** The loader hands the bytes straight to the parser with
no base path, so a `.gltf` with sidecar `.bin`/texture files will not resolve
its references. Draco and Meshopt compression are both handled.

**The wheels must be geometrically separable.** The loader tries two routes,
in order:

1. **Named nodes.** If the model has nodes containing `wheel_front` and
   `wheel_rear` (case-insensitive), they're detached directly. Cleanest.
   Change the names in `DEFAULT_BIKE_FITTING` in
   `src/entities/BikeVisuals.ts` if yours differ.
2. **Automatic splitting.** Otherwise the wheels are found by geometry and cut
   out of whatever mesh they're merged into. This exists because Sketchfab's
   auto-converted glTF merges geometry *by material*, so a bike arrives as
   `Object_2 … Object_24` with both tyres sharing one mesh — the parts are
   gone, even though the model is fine. Rejecting those would rule out most of
   what you can actually download.

The splitter applies two tests, and a mesh must pass both:

1. **Inside the disc** — essentially all of it lies within one of the two wheel
   circles.
2. **Wrapped around the hub** — its triangles are spread right around the axle,
   as any solid of revolution is.

The second test is what stops a mudguard, a silencer or a fitting bolted near
the axle from being taken for part of the wheel: they sit inside the disc but
cover only a narrow arc. Tyres, rims, hubs and brake discs occupy every sector;
a mudguard occupies about a quarter of them.

Anything that fails stays on the body, which is the safe direction — a brake
disc that stays still inside a spinning wheel is nearly invisible, while a
mudguard rotating with the wheel is unmissable. `check:bike` lists what was
rejected this way, so you can see whether it made the right call.

What it can't rescue is a model whose wheels are genuinely fused into the
frame as one surface. For that, split them in Blender and name them.

**Budget about 50k faces.** Six bikes are on screen at once.

## What you do *not* have to get right

Scale, heading and ride height are measured off the model, not configured:

| Derived | How |
| --- | --- |
| Scale | Distance between the two hubs, matched to the physics wheelbase (1.4 m). Units are irrelevant — cm, inches or arbitrary all fit. |
| Heading | Rear hub → front hub is forward, yawed to face local +Z. |
| Which end is front | Whichever hub has more model standing above it — forks and bars at the front, only a seat behind. |
| Ride height | Hub midpoint placed at the suspension's rest position. |
| Wheel pose | Each wheel's axle is measured from its geometry and the wheel straightened onto it. A model posed with the bars turned still gets a straight front wheel. |

**Forks and bars turn too**, when the model allows it. The loader recovers
the original parts as connected pieces of geometry, finds the fork tubes,
and everything close to the fork axis at the front — forks, fender,
headlight, bars, mirrors — becomes a steering assembly that turns with the
wheel. A model posed with the bars turned is straightened and re-centred
first; the steering axis is taken from the wheel's own pose, which is more
reliable than the tubes. Tank-mounted parts near the head stock (fuel cap,
badges) and engine parts near the axis are kept on the frame by symmetry and
position tests. `check:bike` reports the rake, how many parts steer, how
many nearby parts were held back, and how far off-centre the assembly sits;
set `BIKE_FIT_VERBOSE=1` to list every part and where it went.

So a model that is 100x too big, rotated 90°, and centred on its front axle
still comes out fitted.

## Check before you look

    npm run check:bike            # public/assets/bike.glb
    npm run check:bike other.glb

Reports how the wheels were found, the measured wheelbase and scale, the
fitted wheel radius against the physics value, and whether any bodywork hangs
below the tyres. Faster than loading the game, and it fails loudly on a model
that won't work.

## Fine-tuning

Run `npm run dev` and open the **Bike Model Fitting** folder in the tuning
panel (it only appears when a model actually loaded). The sliders re-fit and
hot-swap all six bikes live, so you can nudge scale and position while riding
rather than guessing, rebuilding and reloading.

`yaw offset` exists for one specific case: if the bike faces backwards, the
front and rear wheel node names are swapped in the model. Set it to 180, or
swap the two names in the fitting config.

## Reading the console

On a successful fit you get the measured wheelbase, the derived scale, the
corrected heading, and the resulting wheel radius against the 0.35 m the
physics uses. **Watch that last pair.** A big gap means the model's
proportions genuinely differ from the physics bike — the wheels will look
right relative to each other but wrong relative to the suspension travel.

## Riders

`rider_player.glb` and `rider_ai.glb` are recognised by the loader and loaded,
but nothing consumes them yet — riders are still capsules. Wiring a rigged
mesh to the ragdoll's bones is a separate piece of work.

---

# Dropping in a rider

The rider comes from **[Mixamo](https://www.mixamo.com/)** (free with an Adobe
account), because it is the one place that gives you a rigged character *and*
a matching animation library in one go. Everything goes in
**`public/assets/rider/`**, as FBX straight from the download dialog — no
conversion.

## 1. The character — `rider.fbx`

Pick any character on the Characters tab. A realistic human is best; the
grey **Y Bot** is fine for testing and has the smallest file. If there's a
motorcycle-racer character in the list, that's the one.

Download with: **Format: FBX Binary · Pose: T-pose** (download the character
itself, not an animation) · **Skin: With Skin**. Save as `rider.fbx`.

## 2. The animations — one file each

Search the Animations tab for each of these, apply it to the same character,
and download with **Format: FBX Binary · Skin: Without Skin · 30 fps ·
Keyframe Reduction: none**:

| Save as | Search for | What it's for |
| --- | --- | --- |
| `ride.fbx` | *Driving* (or any seated pose) | On the bike |
| `idle.fbx` | *Idle* | Standing still |
| `getup.fbx` | *Getting Up* / *Stand Up* (from lying on the ground) | After a crash |
| `run.fbx` | *Running* | Chasing the bike |
| `punch.fbx` | *Punching* (a single jab, not a combo) | P |
| `kick.fbx` | *Kicking* (a side or front kick) | K |

"Without Skin" matters: it keeps each animation file small (a few hundred
KB) by leaving out the mesh, which `rider.fbx` already has. All Mixamo
characters share one skeleton, so any clip fits any character.

## 3. Check it

    npm run check:rider

lists each file's skeleton, height, triangle count and clips, and flags any
key bone that's missing. Run it before loading the game.
