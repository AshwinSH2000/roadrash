import RAPIER from "@dimforge/rapier3d-compat";

export class PhysicsWorld {
  readonly world: RAPIER.World;

  private constructor(world: RAPIER.World) {
    this.world = world;
  }

  static async create(gravity = { x: 0, y: -9.81, z: 0 }): Promise<PhysicsWorld> {
    await RAPIER.init();
    const world = new RAPIER.World(gravity);
    return new PhysicsWorld(world);
  }

  step(): void {
    this.world.step();
  }
}

export { RAPIER };
