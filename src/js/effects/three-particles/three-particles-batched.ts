import * as THREE from 'three';

const MAX_PARTICLES = 2000;
const PARTICLES_PER_EMITTER = 1000;

type Particle = {
  alive: boolean;
  life: number;
  maxLife: number;
  velocity: THREE.Vector3;
};

type Emitter = {
  position: THREE.Vector3;
  rate: number;
  accumulator: number;
  startIndex: number;
};

export function createBatchTest(scene: THREE.Scene) {
  // ---------- Geometry ----------
  const geometry = new THREE.BufferGeometry();

  const positions = new Float32Array(MAX_PARTICLES * 3);
  const isActive = new Float32Array(MAX_PARTICLES);

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('isActive', new THREE.BufferAttribute(isActive, 1));

  // ---------- Material ----------
  const material = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 0.08,
    transparent: true,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  scene.add(points);

  // ---------- Particle pool ----------
  const particles: Particle[] = Array.from({ length: MAX_PARTICLES }, () => ({
    alive: false,
    life: 0,
    maxLife: 0,
    velocity: new THREE.Vector3(),
  }));

  // ---------- Two emitters ----------
  const emitters: Emitter[] = [
    {
      position: new THREE.Vector3(-1, 0, 0),
      rate: 50,
      accumulator: 0,
      startIndex: 0,
    },
    {
      position: new THREE.Vector3(1, 0, 0),
      rate: 50,
      accumulator: 0,
      startIndex: PARTICLES_PER_EMITTER,
    },
  ];

  // ---------- Spawn ----------
  function spawn(emitter: Emitter) {
    for (
      let i = emitter.startIndex;
      i < emitter.startIndex + PARTICLES_PER_EMITTER;
      i++
    ) {
      if (!particles[i].alive) {
        particles[i].alive = true;
        particles[i].life = 0;
        particles[i].maxLife = 2;

        particles[i].velocity.set(
          (Math.random() - 0.5) * 0.3,
          Math.random() * 1.2,
          (Math.random() - 0.5) * 0.3
        );

        positions[i * 3] = emitter.position.x;
        positions[i * 3 + 1] = emitter.position.y;
        positions[i * 3 + 2] = emitter.position.z;

        isActive[i] = 1;
        return;
      }
    }
  }

  // ---------- Update ----------
  function update(delta: number) {
    // Emit
    for (const emitter of emitters) {
      emitter.accumulator += emitter.rate * delta;
      while (emitter.accumulator >= 1) {
        spawn(emitter);
        emitter.accumulator--;
      }
    }

    // Simulate
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p.alive) continue;

      p.life += delta;
      if (p.life >= p.maxLife) {
        p.alive = false;
        isActive[i] = 0;
        continue;
      }

      positions[i * 3] += p.velocity.x * delta;
      positions[i * 3 + 1] += p.velocity.y * delta;
      positions[i * 3 + 2] += p.velocity.z * delta;
    }

    geometry.attributes.position.needsUpdate = true;
  }

  return { update, points };
}
