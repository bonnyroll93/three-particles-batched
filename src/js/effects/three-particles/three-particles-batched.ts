import * as THREE from 'three';
import { Gyroscope } from 'three/examples/jsm/misc/Gyroscope.js';
import { FBM } from 'three-noise/build/three-noise.module.js';
import ParticleSystemVertexShader from './shaders/particle-system-vertex-shader.glsl.js';
import ParticleSystemFragmentShader from './shaders/particle-system-fragment-shader.glsl.js';
import { applyModifiers } from './three-particles-modifiers.js';
import {
  calculateRandomPositionAndVelocityOnBox,
  calculateRandomPositionAndVelocityOnCircle,
  calculateRandomPositionAndVelocityOnCone,
  calculateRandomPositionAndVelocityOnRectangle,
  calculateRandomPositionAndVelocityOnSphere,
  calculateValue,
  createDefaultParticleTexture,
} from './three-particles-utils.js';
import { EmitFrom, Shape, SimulationSpace, TimeMode, LifeTimeCurve } from './three-particles-enums.js';
import { ObjectUtils } from '@newkrok/three-utils';
import type {
  Constant,
  GeneralData,
  NormalizedParticleSystemConfig,
  ParticleSystemConfig,
  ParticleSystem,
  LifetimeCurve,
} from './types.js';

interface BatchedParticleSystemEntry {
  offset: number;
  maxParticles: number;
  normalizedConfig: NormalizedParticleSystemConfig;
  generalData: GeneralData;
  startPositions: THREE.Vector3[];
  velocities: THREE.Vector3[];
  wrapper?: Gyroscope;
  lastEmissionTime: number;
  duration: number;
  looping: boolean;
  onUpdate?: Function;
  onComplete?: Function;
}

const calculatePositionAndVelocity = (
  generalData: GeneralData,
  { shape, sphere, cone, circle, rectangle, box }: NormalizedParticleSystemConfig['shape'],
  startSpeed: Constant | LifetimeCurve | { min: number; max: number },
  position: THREE.Vector3,
  velocity: THREE.Vector3
) => {
    let calculatedStartSpeed: number;

    if (typeof startSpeed === 'number') {
    calculatedStartSpeed = startSpeed;
    } else if ('min' in startSpeed && 'max' in startSpeed) {
    // RandomBetweenTwoConstants
    calculatedStartSpeed = THREE.MathUtils.randFloat(startSpeed.min, startSpeed.max);
    } else {
    // LifetimeCurve
    calculatedStartSpeed = calculateValue(generalData.particleSystemId, startSpeed as LifetimeCurve, generalData.normalizedLifetimePercentage);
    }

  switch (shape) {
    case Shape.SPHERE:
      calculateRandomPositionAndVelocityOnSphere(
        position,
        generalData.wrapperQuaternion,
        velocity,
        calculatedStartSpeed,
        {
          radius: sphere?.radius ?? 1,
          radiusThickness: sphere?.radiusThickness ?? 1,
          arc: sphere?.arc ?? 360,
        }
      );
      break;
    case Shape.CONE:
      calculateRandomPositionAndVelocityOnCone(
        position,
        generalData.wrapperQuaternion,
        velocity,
        calculatedStartSpeed,
        {
          angle: cone?.angle ?? 25,
          radius: cone?.radius ?? 1,
          radiusThickness: cone?.radiusThickness ?? 1,
          arc: cone?.arc ?? 360,
        }
      );
      break;
    case Shape.CIRCLE:
      calculateRandomPositionAndVelocityOnCircle(
        position,
        generalData.wrapperQuaternion,
        velocity,
        calculatedStartSpeed,
        {
          radius: circle?.radius ?? 1,
          radiusThickness: circle?.radiusThickness ?? 1,
          arc: circle?.arc ?? 360,
        }
      );
      break;
    case Shape.RECTANGLE:
      calculateRandomPositionAndVelocityOnRectangle(
        position,
        generalData.wrapperQuaternion,
        velocity,
        calculatedStartSpeed,
        {
          rotation: rectangle?.rotation ?? { x: 0, y: 0 },
          scale: rectangle?.scale ?? { x: 1, y: 1 },
        }
      );
      break;
    case Shape.BOX:
      calculateRandomPositionAndVelocityOnBox(
        position,
        generalData.wrapperQuaternion,
        velocity,
        calculatedStartSpeed,
        {
          scale: box?.scale ?? { x: 1, y: 1, z: 1 },
          emitFrom: box?.emitFrom ?? EmitFrom.VOLUME,
        }
      );
      break;
  }
};

export class ParticleSystemBatch {
  private maxParticlesTotal: number = 0;
  private geometry: THREE.BufferGeometry;
  private material: THREE.ShaderMaterial;
  private particleSystems: BatchedParticleSystemEntry[] = [];
  public particleSystem: THREE.Points;

  private isActive!: Float32Array;
  private startLifetime!: Float32Array;
  private startFrame!: Float32Array;
  private size!: Float32Array;
  private rotation!: Float32Array;
  private colorR!: Float32Array;
  private colorG!: Float32Array;
  private colorB!: Float32Array;
  private colorA!: Float32Array;
  private position!: Float32Array;

  constructor() {
    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        elapsed: { value: 0 },
        map: { value: createDefaultParticleTexture() },
        tiles: { value: new THREE.Vector2(1, 1) },
        fps: { value: 30 },
        useFPSForFrameIndex: { value: false },
        backgroundColor: { value: new THREE.Color(1, 1, 1) },
        discardBackgroundColor: { value: false },
        backgroundColorTolerance: { value: 1 },
      },
      vertexShader: ParticleSystemVertexShader,
      fragmentShader: ParticleSystemFragmentShader,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    this.particleSystem = new THREE.Points(this.geometry, this.material);
  }

  addParticleSystem(config: ParticleSystemConfig, externalNow?: number): ParticleSystem {
    const now = externalNow || Date.now();
    const offset = this.maxParticlesTotal;
    const maxParticles = config.maxParticles || 100;

    // Merge config with defaults
    const normalizedConfig: NormalizedParticleSystemConfig = ObjectUtils.deepMerge(
      JSON.parse(JSON.stringify(DEFAULT_PARTICLE_SYSTEM_CONFIG)),
      config,
      { applyToFirstObject: false, skippedProperties: [] }
    );

    const generalData: GeneralData = {
      particleSystemId: offset,
      normalizedLifetimePercentage: 0,
      distanceFromLastEmitByDistance: 0,
      lastWorldPosition: new THREE.Vector3(-99999),
      currentWorldPosition: new THREE.Vector3(-99999),
      worldPositionChange: new THREE.Vector3(),
      worldQuaternion: new THREE.Quaternion(),
      wrapperQuaternion: new THREE.Quaternion(),
      lastWorldQuaternion: new THREE.Quaternion(-99999),
      worldEuler: new THREE.Euler(),
      gravityVelocity: new THREE.Vector3(),
      startValues: {},
      linearVelocityData: undefined,
      orbitalVelocityData: undefined,
      lifetimeValues: {},
      creationTimes: Array.from({ length: maxParticles }, () => 0),
      noise: {
        isActive: normalizedConfig.noise?.isActive || false,
        strength: normalizedConfig.noise?.strength || 0,
        positionAmount: normalizedConfig.noise?.positionAmount || 0,
        rotationAmount: normalizedConfig.noise?.rotationAmount || 0,
        sizeAmount: normalizedConfig.noise?.sizeAmount || 0,
        sampler: normalizedConfig.noise?.isActive
          ? new FBM({
              seed: Math.random(),
              scale: normalizedConfig.noise.frequency || 0.5,
              octaves: normalizedConfig.noise?.octaves || 1,
            })
          : undefined,
        offsets: normalizedConfig.noise?.useRandomOffset
          ? Array.from({ length: maxParticles }, () => Math.random() * 100)
          : undefined,
      },
      isEnabled: true,
    };

    const startPositions = Array.from({ length: maxParticles }, () => new THREE.Vector3());
    const velocities = Array.from({ length: maxParticles }, () => new THREE.Vector3());

    this.maxParticlesTotal += maxParticles;

    const extendAttribute = (arr: Float32Array | undefined, defaultValue = 0) => {
      const oldLength = arr?.length || 0;
      const newArr = new Float32Array(this.maxParticlesTotal);
      if (arr) newArr.set(arr);
      for (let i = oldLength; i < this.maxParticlesTotal; i++) newArr[i] = defaultValue;
      return newArr;
    };

    this.isActive = extendAttribute(this.isActive, 0);
    this.startLifetime = extendAttribute(this.startLifetime, 0);
    this.startFrame = extendAttribute(this.startFrame, 0);
    this.size = extendAttribute(this.size, 1);
    this.rotation = extendAttribute(this.rotation, 0);
    this.colorR = extendAttribute(this.colorR, 1);
    this.colorG = extendAttribute(this.colorG, 1);
    this.colorB = extendAttribute(this.colorB, 1);
    this.colorA = extendAttribute(this.colorA, 1);
    this.position = extendAttribute(this.position, 0);

    this.geometry.setAttribute('isActive', new THREE.BufferAttribute(this.isActive, 1));
    this.geometry.setAttribute('startLifetime', new THREE.BufferAttribute(this.startLifetime, 1));
    this.geometry.setAttribute('startFrame', new THREE.BufferAttribute(this.startFrame, 1));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    this.geometry.setAttribute('rotation', new THREE.BufferAttribute(this.rotation, 1));
    this.geometry.setAttribute('colorR', new THREE.BufferAttribute(this.colorR, 1));
    this.geometry.setAttribute('colorG', new THREE.BufferAttribute(this.colorG, 1));
    this.geometry.setAttribute('colorB', new THREE.BufferAttribute(this.colorB, 1));
    this.geometry.setAttribute('colorA', new THREE.BufferAttribute(this.colorA, 1));
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3));

    // ---- WORLD wrapper ----
    let wrapper: Gyroscope | undefined;
    if (normalizedConfig.simulationSpace === SimulationSpace.WORLD) {
      wrapper = new Gyroscope();
      wrapper.add(this.particleSystem);
    }

    const entry: BatchedParticleSystemEntry = {
      offset,
      maxParticles,
      normalizedConfig,
      generalData,
      startPositions,
      velocities,
      wrapper,
      lastEmissionTime: now,
      duration: normalizedConfig.duration || 5,
      looping: normalizedConfig.looping ?? true,
      onUpdate: normalizedConfig.onUpdate,
      onComplete: normalizedConfig.onComplete,
    };

    this.particleSystems.push(entry);
    return this._createParticleSystemAPI(entry);
  }

  private _createParticleSystemAPI(entry: BatchedParticleSystemEntry): ParticleSystem {
    const { generalData } = entry;
    return {
      instance: entry.wrapper || this.particleSystem,
      resumeEmitter: () => (generalData.isEnabled = true),
      pauseEmitter: () => (generalData.isEnabled = false),
      dispose: () => {
        for (let i = 0; i < entry.maxParticles; i++) {
          const globalIndex = entry.offset + i;
          this.isActive[globalIndex] = 0;
          this.colorA[globalIndex] = 0;
        }
        this.geometry.attributes.isActive.needsUpdate = true;
        this.geometry.attributes.colorA.needsUpdate = true;
      },
    };
  }

  update({ now, delta, elapsed }: { now: number; delta: number; elapsed: number }) {
    this.material.uniforms.elapsed.value = elapsed;

    for (const entry of this.particleSystems) {
      if (!entry.generalData.isEnabled) continue;

      // TODO: aggiornamento delle particelle (come nel tuo codice originale)
    }
  }
}

// --- DEFAULT CONFIG ---
const DEFAULT_PARTICLE_SYSTEM_CONFIG: ParticleSystemConfig = {
  transform: { position: new THREE.Vector3(), rotation: new THREE.Vector3(), scale: new THREE.Vector3(1, 1, 1) },
  duration: 5,
  looping: true,
  startLifetime: 5,
  startSpeed: 1,
  startSize: 1,
  startOpacity: 1,
  startRotation: 0,
  startColor: { min: { r: 1, g: 1, b: 1 }, max: { r: 1, g: 1, b: 1 } },
  gravity: 0,
  simulationSpace: SimulationSpace.LOCAL,
  maxParticles: 100,
  emission: { rateOverTime: 10, rateOverDistance: 0 },
  shape: {
    shape: Shape.SPHERE,
    sphere: { radius: 1, radiusThickness: 1, arc: 360 },
    cone: { angle: 25, radius: 1, radiusThickness: 1, arc: 360 },
    circle: { radius: 1, radiusThickness: 1, arc: 360 },
    rectangle: { rotation: { x: 0, y: 0 }, scale: { x: 1, y: 1 } },
    box: { scale: { x: 1, y: 1, z: 1 }, emitFrom: EmitFrom.VOLUME },
  },
  map: undefined,
  renderer: { blending: THREE.NormalBlending, discardBackgroundColor: false, backgroundColorTolerance: 1, backgroundColor: { r: 1, g: 1, b: 1 }, transparent: true, depthTest: true, depthWrite: false },
  velocityOverLifetime: { isActive: false, linear: { x: 0, y: 0, z: 0 }, orbital: { x: 0, y: 0, z: 0 } },
  sizeOverLifetime: { isActive: false, lifetimeCurve: { type: LifeTimeCurve.BEZIER, scale: 1, bezierPoints: [{ x: 0, y: 0, percentage: 0 }, { x: 1, y: 1, percentage: 1 }] } },
  opacityOverLifetime: { isActive: false, lifetimeCurve: { type: LifeTimeCurve.BEZIER, scale: 1, bezierPoints: [{ x: 0, y: 0, percentage: 0 }, { x: 1, y: 1, percentage: 1 }] } },
  rotationOverLifetime: { isActive: false, min: 0, max: 0 },
  noise: { isActive: false, useRandomOffset: false, strength: 1, frequency: 0.5, octaves: 1, positionAmount: 1, rotationAmount: 0, sizeAmount: 0 },
  textureSheetAnimation: { tiles: new THREE.Vector2(1, 1), timeMode: TimeMode.LIFETIME, fps: 30, startFrame: 0 },
};

export const getDefaultParticleSystemConfigBatch = () => JSON.parse(JSON.stringify(DEFAULT_PARTICLE_SYSTEM_CONFIG));
