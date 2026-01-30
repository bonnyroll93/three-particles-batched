import { ObjectUtils } from '@newkrok/three-utils';
import * as THREE from 'three';
import { FBM } from 'three-noise/build/three-noise.module.js';
import ParticleSystemFragmentShader from './shaders/particle-system-fragment-shader.glsl.js';
import ParticleSystemVertexShader from './shaders/particle-system-vertex-shader.glsl.js';
import { removeBezierCurveFunction } from './three-particles-bezier.js';
import {
  EmitFrom,
  LifeTimeCurve,
  Shape,
  SimulationSpace,
  TimeMode,
} from './three-particles-enums';
import { applyModifiers } from './three-particles-modifiers.js';
import {
  calculateRandomPositionAndVelocityOnBox,
  calculateRandomPositionAndVelocityOnCircle,
  calculateRandomPositionAndVelocityOnCone,
  calculateRandomPositionAndVelocityOnRectangle,
  calculateRandomPositionAndVelocityOnSphere,
  calculateValue,
  getCurveFunctionFromConfig,
  isLifeTimeCurve,
  createDefaultParticleTexture,
} from './three-particles-utils.js';

import type {
  Constant,
  CycleData,
  GeneralData,
  LifetimeCurve,
  NormalizedParticleSystemConfig,
  ParticleSystem,
  ParticleSystemConfig,
  ParticleSystemInstance,
  Point3D,
  RandomBetweenTwoConstants,
  ShapeConfig,
} from './types.js';

export * from './types.js';

let _particleSystemId = 0;
let createdParticleSystems: Array<ParticleSystemInstance & any> = [];

// ========== GLOBAL INSTANCED BUFFER (BATCHING) ==========
let _batchedMaterial: THREE.ShaderMaterial | null = null;
let _batchedPoints: THREE.Points | null = null;

let MAX_SYSTEMS = 64;
let _batchedLocked = false;

let _maxTotalParticles = 0;
let _nextParticleStartIndex = 0;
let _createdSystemCount = 0;

const _instanceData = new Map<
  number,
  {
    startIndex: number;
    particleCount: number;
    generalData: GeneralData;
    instanceIndex: number;
  }
>();

export const blendingMap = {
  'THREE.NoBlending': THREE.NoBlending,
  'THREE.NormalBlending': THREE.NormalBlending,
  'THREE.AdditiveBlending': THREE.AdditiveBlending,
  'THREE.SubtractiveBlending': THREE.SubtractiveBlending,
  'THREE.MultiplyBlending': THREE.MultiplyBlending,
} as const;

// ===== FIX TS: safe indexing blendingMap =====
type BlendingKey = keyof typeof blendingMap;
const isBlendingKey = (v: unknown): v is BlendingKey => typeof v === 'string' && v in blendingMap;
const resolveBlending = (v: unknown): THREE.Blending | undefined => {
  if (typeof v === 'number') return v as THREE.Blending;
  if (isBlendingKey(v)) return blendingMap[v];
  return undefined;
};

export const getDefaultParticleSystemConfig = () =>
  JSON.parse(JSON.stringify(DEFAULT_PARTICLE_SYSTEM_CONFIG));

const DEFAULT_PARTICLE_SYSTEM_CONFIG: ParticleSystemConfig = {
  transform: {
    position: new THREE.Vector3(),
    rotation: new THREE.Vector3(),
    scale: new THREE.Vector3(1, 1, 1),
  },
  duration: 5.0,
  looping: true,
  startDelay: 0,
  startLifetime: 5.0,
  startSpeed: 1.0,
  startSize: 1.0,
  startOpacity: 1.0,
  startRotation: 0.0,
  startColor: {
    min: { r: 1.0, g: 1.0, b: 1.0 },
    max: { r: 1.0, g: 1.0, b: 1.0 },
  },
  gravity: 0.0,
  simulationSpace: SimulationSpace.LOCAL,
  maxParticles: 100.0,
  emission: {
    rateOverTime: 10.0,
    rateOverDistance: 0.0,
  },
  shape: {
    shape: Shape.SPHERE,
    sphere: { radius: 1.0, radiusThickness: 1.0, arc: 360.0 },
    cone: { angle: 25.0, radius: 1.0, radiusThickness: 1.0, arc: 360.0 },
    circle: { radius: 1.0, radiusThickness: 1.0, arc: 360.0 },
    rectangle: { rotation: { x: 0.0, y: 0.0 }, scale: { x: 1.0, y: 1.0 } },
    box: { scale: { x: 1.0, y: 1.0, z: 1.0 }, emitFrom: EmitFrom.VOLUME },
  },
  map: undefined,
  renderer: {
    blending: THREE.NormalBlending,
    discardBackgroundColor: false,
    backgroundColorTolerance: 1.0,
    backgroundColor: { r: 1.0, g: 1.0, b: 1.0 },
    transparent: true,
    depthTest: true,
    depthWrite: false,
  },
  velocityOverLifetime: {
    isActive: false,
    linear: { x: 0, y: 0, z: 0 },
    orbital: { x: 0, y: 0, z: 0 },
  },
  sizeOverLifetime: {
    isActive: false,
    lifetimeCurve: {
      type: LifeTimeCurve.BEZIER,
      scale: 1,
      bezierPoints: [
        { x: 0, y: 0, percentage: 0 },
        { x: 1, y: 1, percentage: 1 },
      ],
    },
  },
  opacityOverLifetime: {
    isActive: false,
    lifetimeCurve: {
      type: LifeTimeCurve.BEZIER,
      scale: 1,
      bezierPoints: [
        { x: 0, y: 0, percentage: 0 },
        { x: 1, y: 1, percentage: 1 },
      ],
    },
  },
  rotationOverLifetime: {
    isActive: false,
    min: 0.0,
    max: 0.0,
  },
  noise: {
    isActive: false,
    useRandomOffset: false,
    strength: 1.0,
    frequency: 0.5,
    octaves: 1,
    positionAmount: 1.0,
    rotationAmount: 0.0,
    sizeAmount: 0.0,
  },
  textureSheetAnimation: {
    tiles: new THREE.Vector2(1.0, 1.0),
    timeMode: TimeMode.LIFETIME,
    fps: 30.0,
    startFrame: 0,
  },
};

export const setBatchedCapacity = ({
  totalMaxParticles,
  maxSystems = 64,
}: {
  totalMaxParticles: number;
  maxSystems?: number;
}) => {
  if (_batchedLocked) {
    throw new Error(
      'setBatchedCapacity() must be called BEFORE creating any particle system.'
    );
  }

  MAX_SYSTEMS = Math.floor(maxSystems);
  _maxTotalParticles = Math.floor(totalMaxParticles);

  if (MAX_SYSTEMS <= 0) throw new Error('maxSystems must be > 0');
  if (_maxTotalParticles <= 0) throw new Error('totalMaxParticles must be > 0');
};

export const getBatchedCapacity = () => ({
  totalMaxParticles: _maxTotalParticles,
  maxSystems: MAX_SYSTEMS,
});

export const getBatchedStats = () => ({
  capacity: _maxTotalParticles,
  allocated: _nextParticleStartIndex,
  systemsCreated: _createdSystemCount,
  maxSystems: MAX_SYSTEMS,
});

// ========== BATCHED RENDER OBJECT FACTORY ==========
let _createBatchedParticleRenderObject = (maxTotalParticles: number): THREE.Points => {
  const geometry = new THREE.BufferGeometry();

  const mkAttr = (arr: Float32Array, itemSize: number) => {
    const a = new THREE.BufferAttribute(arr, itemSize);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  };

  geometry.setAttribute('emitterIndex', mkAttr(new Float32Array(maxTotalParticles), 1));

  geometry.setAttribute('position', mkAttr(new Float32Array(maxTotalParticles * 3), 3));
  geometry.setAttribute('isActive', mkAttr(new Float32Array(maxTotalParticles), 1));
  geometry.setAttribute('lifetime', mkAttr(new Float32Array(maxTotalParticles), 1));
  geometry.setAttribute('startLifetime', mkAttr(new Float32Array(maxTotalParticles), 1));
  geometry.setAttribute('size', mkAttr(new Float32Array(maxTotalParticles), 1));

  // legacy (non usato nel shader)
  geometry.setAttribute('opacity', mkAttr(new Float32Array(maxTotalParticles), 1));

  geometry.setAttribute('rotation', mkAttr(new Float32Array(maxTotalParticles), 1));
  geometry.setAttribute('colorR', mkAttr(new Float32Array(maxTotalParticles), 1));
  geometry.setAttribute('colorG', mkAttr(new Float32Array(maxTotalParticles), 1));
  geometry.setAttribute('colorB', mkAttr(new Float32Array(maxTotalParticles), 1));
  geometry.setAttribute('colorA', mkAttr(new Float32Array(maxTotalParticles), 1));
  geometry.setAttribute('startFrame', mkAttr(new Float32Array(maxTotalParticles), 1));

  geometry.setAttribute('instanceMatrix', mkAttr(new Float32Array(16 * MAX_SYSTEMS), 16));
  geometry.setAttribute('instanceColor', mkAttr(new Float32Array(4 * MAX_SYSTEMS), 4));
  geometry.setAttribute('instanceStartIndex', mkAttr(new Float32Array(MAX_SYSTEMS), 1));
  geometry.setAttribute('instanceParticleCount', mkAttr(new Float32Array(MAX_SYSTEMS), 1));
  geometry.setAttribute('instanceSimulationSpace', mkAttr(new Float32Array(MAX_SYSTEMS), 1));

  geometry.setAttribute('birthTime', mkAttr(new Float32Array(maxTotalParticles), 1));


  const points = new THREE.Points(geometry, _batchedMaterial!);
  points.frustumCulled = false;
  points.position.set(0, 0, 0);
  points.quaternion.identity();
  points.scale.set(1, 1, 1);

  return points;
};

const initializeBatchedRenderer = () => {
  if (_batchedPoints) return;

  _maxTotalParticles = Math.max(_maxTotalParticles || 0, 2000);

  const createUniforms = () => ({
    elapsed: { value: 0.0 },
    map: { value: createDefaultParticleTexture() },

    // Flipbook globals
    tiles: { value: new THREE.Vector2(1, 1) },
    fps: { value: 30.0 },
    instanceUseFPSForFrameIndex: { value: new Float32Array(MAX_SYSTEMS).fill(0) },

    // Per-system emitter matrices (packed in vec4 rows)
    instanceMat0: { value: Array.from({ length: MAX_SYSTEMS }, () => new THREE.Vector4(1, 0, 0, 0)) },
    instanceMat1: { value: Array.from({ length: MAX_SYSTEMS }, () => new THREE.Vector4(0, 1, 0, 0)) },
    instanceMat2: { value: Array.from({ length: MAX_SYSTEMS }, () => new THREE.Vector4(0, 0, 1, 0)) },
    instanceMat3: { value: Array.from({ length: MAX_SYSTEMS }, () => new THREE.Vector4(0, 0, 0, 1)) },

    // Per-system metadata
    instanceStartIndex: { value: new Float32Array(MAX_SYSTEMS).fill(0) },
    instanceParticleCount: { value: new Float32Array(MAX_SYSTEMS).fill(0) },
    instanceMatrixCount: { value: 0 },
    instanceSimulationSpace: { value: new Float32Array(MAX_SYSTEMS).fill(0) },

    // Flipbook per-system (range assoluto su atlas, startFrame per-particle è relativo al range)
    instanceFlipbookMode: { value: new Float32Array(MAX_SYSTEMS).fill(0) }, // 0=LOOP,1=ONCE,2=PINGPONG,3=CLAMP
    instanceFlipbookRangeStart: { value: new Float32Array(MAX_SYSTEMS).fill(0) }, // inclusive
    instanceFlipbookRangeEnd: { value: new Float32Array(MAX_SYSTEMS).fill(-1) },  // inclusive, -1 => frames-1
  });

  const createMaterial = () =>
    new THREE.ShaderMaterial({
      defines: { MAX_SYSTEMS }, // deve matchare il nome nel tuo shader [file:1]
      uniforms: createUniforms(),
      vertexShader: ParticleSystemVertexShader,
      fragmentShader: ParticleSystemFragmentShader,

      transparent: true,
      // NB: verrà sovrascritto dal primo createParticleSystem() che passa renderer.blending. [file:1]
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      vertexColors: true,
    });

  _batchedMaterial = createMaterial();
  _batchedPoints = _createBatchedParticleRenderObject(_maxTotalParticles);
  _batchedLocked = true;
};

const calculatePositionAndVelocity = (
  generalData: GeneralData,
  { shape, sphere, cone, circle, rectangle, box }: ShapeConfig,
  startSpeed: Constant | RandomBetweenTwoConstants | LifetimeCurve,
  position: THREE.Vector3,
  velocity: THREE.Vector3
) => {
  const calculatedStartSpeed = calculateValue(
    generalData.particleSystemId,
    startSpeed,
    generalData.normalizedLifetimePercentage
  );

  switch (shape) {
    case Shape.SPHERE:
      calculateRandomPositionAndVelocityOnSphere(
        position,
        generalData.wrapperQuaternion,
        velocity,
        calculatedStartSpeed,
        sphere as Required<NonNullable<ShapeConfig['sphere']>>
      );
      break;
    case Shape.CONE:
      calculateRandomPositionAndVelocityOnCone(
        position,
        generalData.wrapperQuaternion,
        velocity,
        calculatedStartSpeed,
        cone as Required<NonNullable<ShapeConfig['cone']>>
      );
      break;
    case Shape.CIRCLE:
      calculateRandomPositionAndVelocityOnCircle(
        position,
        generalData.wrapperQuaternion,
        velocity,
        calculatedStartSpeed,
        circle as Required<NonNullable<ShapeConfig['circle']>>
      );
      break;
    case Shape.RECTANGLE:
      calculateRandomPositionAndVelocityOnRectangle(
        position,
        generalData.wrapperQuaternion,
        velocity,
        calculatedStartSpeed,
        rectangle as Required<NonNullable<ShapeConfig['rectangle']>>
      );
      break;
    case Shape.BOX:
      calculateRandomPositionAndVelocityOnBox(
        position,
        generalData.wrapperQuaternion,
        velocity,
        calculatedStartSpeed,
        box as Required<NonNullable<ShapeConfig['box']>>
      );
      break;
  }
};

const destroyParticleSystem = (particleSystemId: number) => {
  const meta = _instanceData.get(particleSystemId);

  if (meta && _batchedPoints) {
    const instCountAttr = _batchedPoints.geometry.getAttribute('instanceParticleCount') as THREE.BufferAttribute;
    instCountAttr.array[meta.instanceIndex] = 0;
    instCountAttr.needsUpdate = true;

    if (_batchedMaterial) {
      (_batchedMaterial.uniforms.instanceParticleCount.value as Float32Array)[meta.instanceIndex] = 0;
      (_batchedMaterial.uniforms.instanceSimulationSpace.value as Float32Array)[meta.instanceIndex] = 0;
    }
  }

  createdParticleSystems = createdParticleSystems.filter(({ generalData }) => {
    if (generalData.particleSystemId === particleSystemId) {
      removeBezierCurveFunction(particleSystemId);
      return false;
    }
    return true;
  });

  _instanceData.delete(particleSystemId);
};

// scratch riusati
const _tmpPos = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _tmpScale = new THREE.Vector3();
const _tmpMat = new THREE.Matrix4();
const _tmpMatInv = new THREE.Matrix4();

// ===== ROTATION FIX SCRATCH =====
const _baseEuler = new THREE.Euler();
const _baseQuat = new THREE.Quaternion();

const _shapeOffset = new THREE.Vector3();
const _spawnedVelocity = new THREE.Vector3();
const _invBaseQuat = new THREE.Quaternion();

const _readEmitterMatrix = (instanceIndex: number, out: THREE.Matrix4) => {
  if (!_batchedPoints) return false;
  const instMatrixAttr = _batchedPoints.geometry.getAttribute('instanceMatrix') as THREE.BufferAttribute;
  out.fromArray(instMatrixAttr.array as any, instanceIndex * 16);
  return true;
};

const _getEmitterTRS = (
  instanceIndex: number,
  outPos: THREE.Vector3,
  outQuat: THREE.Quaternion,
  outScale: THREE.Vector3
) => {
  if (!_readEmitterMatrix(instanceIndex, _tmpMat)) return false;
  _tmpMat.decompose(outPos, outQuat, outScale);
  return true;
};

export const createParticleSystem = (
  config: ParticleSystemConfig = DEFAULT_PARTICLE_SYSTEM_CONFIG,
  externalNow?: number
): ParticleSystem => {
  const now = externalNow ?? Date.now();

  const generalData: GeneralData = {
    particleSystemId: _particleSystemId++,
    normalizedLifetimePercentage: 0,
    distanceFromLastEmitByDistance: 0,

    lastWorldPosition: new THREE.Vector3(-99999, -99999, -99999),
    currentWorldPosition: new THREE.Vector3(-99999, -99999, -99999),
    worldPositionChange: new THREE.Vector3(),
    worldQuaternion: new THREE.Quaternion(),
    wrapperQuaternion: new THREE.Quaternion(),
    lastWorldQuaternion: new THREE.Quaternion(-99999, -99999, -99999, -99999) as any,
    worldEuler: new THREE.Euler(),
    gravityVelocity: new THREE.Vector3(0, 0, 0),

    startValues: {},
    linearVelocityData: undefined,
    orbitalVelocityData: undefined,
    lifetimeValues: {},
    creationTimes: [],
    noise: {
      isActive: false,
      strength: 0,
      positionAmount: 0,
      rotationAmount: 0,
      sizeAmount: 0,
    },
    isEnabled: true,
  };

  const normalizedConfig = ObjectUtils.deepMerge(
    DEFAULT_PARTICLE_SYSTEM_CONFIG as NormalizedParticleSystemConfig,
    config,
    { applyToFirstObject: false, skippedProperties: [] }
  ) as NormalizedParticleSystemConfig;

  // Support blending string (FIX TS)
  {
    const resolved = resolveBlending((normalizedConfig as any).renderer?.blending);
    if (resolved !== undefined) (normalizedConfig as any).renderer.blending = resolved;
  }

  const {
    transform,
    duration,
    looping,
    startDelay,
    startLifetime,
    startSpeed,
    startSize,
    startColor,
    gravity,
    simulationSpace,
    maxParticles,
    emission,
    onUpdate,
    onComplete,
    map,
    startOpacity,
    startRotation,
    noise,
    velocityOverLifetime,
    rotationOverLifetime,
    textureSheetAnimation,
  } = normalizedConfig as any;

  const maxP = Math.floor(maxParticles ?? 100);

  initializeBatchedRenderer();

  // Apply renderer settings to the (single) batched material.
  if (_batchedMaterial && (normalizedConfig as any).renderer) {
    const r = (normalizedConfig as any).renderer;
    if (r.blending !== undefined) _batchedMaterial.blending = r.blending;
    if (r.transparent !== undefined) _batchedMaterial.transparent = r.transparent;
    if (r.depthTest !== undefined) _batchedMaterial.depthTest = r.depthTest;
    if (r.depthWrite !== undefined) _batchedMaterial.depthWrite = r.depthWrite;
    _batchedMaterial.needsUpdate = true;
  }

  const requiredTotal = _nextParticleStartIndex + maxP;
  if (requiredTotal > _maxTotalParticles) {
    throw new Error(
      `[three-particles-batched] Batched capacity exceeded: requiredTotal=${requiredTotal} > totalMaxParticles=${_maxTotalParticles}.`
    );
  }
  if (!_batchedPoints || !_batchedMaterial) throw new Error('Batched renderer not initialized');

  const startIndex = _nextParticleStartIndex;
  _nextParticleStartIndex += maxP;

  const instanceIndex = _createdSystemCount++;
  if (instanceIndex >= MAX_SYSTEMS) throw new Error(`MAX_SYSTEMS exceeded (${MAX_SYSTEMS}).`);

  generalData.creationTimes = Array.from({ length: maxP }, () => 0);

  const velocities = Array.from({ length: maxP }, () => new THREE.Vector3());
  const startPositions = Array.from({ length: maxP }, () => new THREE.Vector3());

  // ===== HIGH IMPACT PERF: free list + active list =====
  const freeList = new Int32Array(maxP);
  for (let i = 0; i < maxP; i++) freeList[i] = i;

  const activeList = new Int32Array(maxP);
  const activeSlot = new Int32Array(maxP);
  activeSlot.fill(-1);

  const rotOLActive = !!rotationOverLifetime?.isActive;
  const noiseActive = !!noise?.isActive;

  // startValues
  (generalData.startValues as any).startSize = Array.from({ length: maxP }, () =>
    calculateValue(generalData.particleSystemId, startSize, 0)
  );
  (generalData.startValues as any).startOpacity = Array.from({ length: maxP }, () =>
    calculateValue(generalData.particleSystemId, startOpacity, 0)
  );

  // rotationOverLifetime random per particle
  if (rotOLActive) {
    (generalData.lifetimeValues as any).rotationOverLifetime = Array.from({ length: maxP }, () =>
      THREE.MathUtils.randFloat(rotationOverLifetime.min!, rotationOverLifetime.max!)
    );
  }

  // velocityOverLifetime data (se attivo)
  if (velocityOverLifetime?.isActive) {
    generalData.linearVelocityData = Array.from({ length: maxP }, () => ({
      speed: new THREE.Vector3(
        velocityOverLifetime.linear.x ? calculateValue(generalData.particleSystemId, velocityOverLifetime.linear.x, 0) : 0,
        velocityOverLifetime.linear.y ? calculateValue(generalData.particleSystemId, velocityOverLifetime.linear.y, 0) : 0,
        velocityOverLifetime.linear.z ? calculateValue(generalData.particleSystemId, velocityOverLifetime.linear.z, 0) : 0
      ),
      valueModifiers: {
        x: isLifeTimeCurve(velocityOverLifetime.linear.x || 0)
          ? getCurveFunctionFromConfig(generalData.particleSystemId, velocityOverLifetime.linear.x as LifetimeCurve)
          : undefined,
        y: isLifeTimeCurve(velocityOverLifetime.linear.y || 0)
          ? getCurveFunctionFromConfig(generalData.particleSystemId, velocityOverLifetime.linear.y as LifetimeCurve)
          : undefined,
        z: isLifeTimeCurve(velocityOverLifetime.linear.z || 0)
          ? getCurveFunctionFromConfig(generalData.particleSystemId, velocityOverLifetime.linear.z as LifetimeCurve)
          : undefined,
      },
    }));

    generalData.orbitalVelocityData = Array.from({ length: maxP }, () => ({
      speed: new THREE.Vector3(
        velocityOverLifetime.orbital.x ? calculateValue(generalData.particleSystemId, velocityOverLifetime.orbital.x, 0) : 0,
        velocityOverLifetime.orbital.y ? calculateValue(generalData.particleSystemId, velocityOverLifetime.orbital.y, 0) : 0,
        velocityOverLifetime.orbital.z ? calculateValue(generalData.particleSystemId, velocityOverLifetime.orbital.z, 0) : 0
      ),
      valueModifiers: {
        x: isLifeTimeCurve(velocityOverLifetime.orbital.x || 0)
          ? getCurveFunctionFromConfig(generalData.particleSystemId, velocityOverLifetime.orbital.x as LifetimeCurve)
          : undefined,
        y: isLifeTimeCurve(velocityOverLifetime.orbital.y || 0)
          ? getCurveFunctionFromConfig(generalData.particleSystemId, velocityOverLifetime.orbital.y as LifetimeCurve)
          : undefined,
        z: isLifeTimeCurve(velocityOverLifetime.orbital.z || 0)
          ? getCurveFunctionFromConfig(generalData.particleSystemId, velocityOverLifetime.orbital.z as LifetimeCurve)
          : undefined,
      },
      positionOffset: new THREE.Vector3(),
    }));
  }

  // noise data (FIX: sampler created when "active" even w/out isActive)
  (generalData.noise as any) = {
    isActive: noiseActive,
    strength: noiseActive ? (noise?.strength ?? 0) : 0,
    positionAmount: noiseActive ? (noise?.positionAmount ?? 0) : 0,
    rotationAmount: noiseActive ? (noise?.rotationAmount ?? 0) : 0,
    sizeAmount: noiseActive ? (noise?.sizeAmount ?? 0) : 0,
    sampler: noiseActive
      ? new FBM({
          seed: Math.random(),
          scale: noise?.frequency ?? 0.5,
          octaves: noise?.octaves ?? 1,
        })
      : undefined,
    offsets: noiseActive && noise?.useRandomOffset
      ? Array.from({ length: maxP }, () => Math.random() * 100)
      : undefined,
  };

  // Init particles inactive
  const isActiveAttr = _batchedPoints.geometry.getAttribute('isActive') as THREE.BufferAttribute;
  const lifetimeAttr = _batchedPoints.geometry.getAttribute('lifetime') as THREE.BufferAttribute;
  const colorAAttrInit = _batchedPoints.geometry.getAttribute('colorA') as THREE.BufferAttribute;

  for (let i = 0; i < maxP; i++) {
    const gi = startIndex + i;
    isActiveAttr.array[gi] = 0;
    lifetimeAttr.array[gi] = 0;
    colorAAttrInit.array[gi] = 0;
  }
  isActiveAttr.needsUpdate = true;
  lifetimeAttr.needsUpdate = true;
  colorAAttrInit.needsUpdate = true;

  _instanceData.set(generalData.particleSystemId, {
    startIndex,
    particleCount: maxP,
    generalData,
    instanceIndex,
  });

  // Per-system attributes
  const instMatrixAttr = _batchedPoints.geometry.getAttribute('instanceMatrix') as THREE.BufferAttribute;
  const instStartAttr = _batchedPoints.geometry.getAttribute('instanceStartIndex') as THREE.BufferAttribute;
  const instCountAttr = _batchedPoints.geometry.getAttribute('instanceParticleCount') as THREE.BufferAttribute;
  const instSimAttr = _batchedPoints.geometry.getAttribute('instanceSimulationSpace') as THREE.BufferAttribute;

  instStartAttr.array[instanceIndex] = startIndex;
  instCountAttr.array[instanceIndex] = maxP;
  instSimAttr.array[instanceIndex] = simulationSpace === SimulationSpace.WORLD ? 1 : 0;

  instStartAttr.needsUpdate = true;
  instCountAttr.needsUpdate = true;
  instSimAttr.needsUpdate = true;

  (_batchedMaterial.uniforms.instanceStartIndex.value as Float32Array)[instanceIndex] = startIndex;
  (_batchedMaterial.uniforms.instanceParticleCount.value as Float32Array)[instanceIndex] = maxP;
  (_batchedMaterial.uniforms.instanceSimulationSpace.value as Float32Array)[instanceIndex] =
    instSimAttr.array[instanceIndex];

  _batchedMaterial.uniforms.instanceMatrixCount.value = Math.max(
    _batchedMaterial.uniforms.instanceMatrixCount.value as number,
    instanceIndex + 1
  );

  const worldPosition = transform.position?.clone() || new THREE.Vector3();
  const worldScale = transform.scale?.clone() || new THREE.Vector3(1, 1, 1);

  // ===== ROTATION FIX: compute baseQuat from config rotation (LOCAL behavior in old version) =====
  _baseEuler.set(
    THREE.MathUtils.degToRad(transform.rotation?.x || 0),
    THREE.MathUtils.degToRad(transform.rotation?.y || 0),
    THREE.MathUtils.degToRad(transform.rotation?.z || 0)
  );
  _baseQuat.setFromEuler(_baseEuler);
  (generalData as any)._baseQuat = _baseQuat.clone();

  const matrix = new THREE.Matrix4().compose(
    worldPosition,
    (generalData as any)._baseQuat,
    worldScale
  );

  matrix.toArray(instMatrixAttr.array as any, instanceIndex * 16);
  instMatrixAttr.needsUpdate = true;

  setEmitterMatrix(generalData.particleSystemId, matrix);

  if (map) _batchedMaterial.uniforms.map.value = map;

  // --- SPRITESHEET TEXTURE SHEET ANIMATION ---
  // --- SPRITESHEET TEXTURE SHEET ANIMATION ---
  if (_batchedMaterial) {
    const tsa = (textureSheetAnimation ?? {}) as any;

    // ---- Global uniforms ----
    if (tsa.tiles) _batchedMaterial.uniforms.tiles.value.copy(tsa.tiles);
    _batchedMaterial.uniforms.fps.value = tsa.fps ?? 30.0;

    // ---- Per-system: TimeMode ----
    // Accetta: enum (TimeMode.FPS), stringhe ("FPS", "TimeMode.FPS"), numeri (1)
    const tm = tsa.timeMode;
    const tmStr = typeof tm === "string" ? tm : "";
    const isFps =
      tm === TimeMode.FPS ||
      tm === 1 ||
      tmStr === "FPS" ||
      tmStr.endsWith(".FPS");

    const fpsArr = _batchedMaterial.uniforms.instanceUseFPSForFrameIndex.value as Float32Array;
    fpsArr[instanceIndex] = isFps ? 1 : 0;

    // ---- Per-system: loop mode ----
    const loopMode = tsa.loopMode ?? "loop";
    const mode =
      loopMode === "once" ? 1 :
      loopMode === "pingpong" ? 2 :
      loopMode === "clamp" ? 3 :
      0;

    // ---- Per-system: range (inclusive). end==null => -1 (shader => frames-1) ----
    const range = tsa.range ?? {};
    const rangeStart = Number.isFinite(range.start) ? Math.floor(range.start) : 0;
    const rangeEnd = range.end == null ? -1 : Math.floor(range.end);

    const modeArr = _batchedMaterial.uniforms.instanceFlipbookMode.value as Float32Array;
    const rsArr   = _batchedMaterial.uniforms.instanceFlipbookRangeStart.value as Float32Array;
    const reArr   = _batchedMaterial.uniforms.instanceFlipbookRangeEnd.value as Float32Array;

    modeArr[instanceIndex] = mode;
    rsArr[instanceIndex] = rangeStart;
    reArr[instanceIndex] = rangeEnd;

    _batchedMaterial.uniformsNeedUpdate = true;
  }

  const calculatedCreationTime = now + calculateValue(generalData.particleSystemId, startDelay) * 1000;

  const instanceData: any = {
    instanceIndex,
    particleSystem: _batchedPoints,
    generalData,
    onUpdate,
    onComplete,
    creationTime: calculatedCreationTime,
    lastEmissionTime: calculatedCreationTime,
    emissionCarry: 0,
    duration,
    looping,
    simulationSpace,
    gravity,
    emission,
    normalizedConfig,
    iterationCount: 0,
    velocities,
    startIndex,
    maxParticles: maxP,
    startPositions,
    freeList,
    freeTop: maxP,      // stack pointer (quanti slot liberi)
    activeList,
    activeCount: 0,     // quanti attivi
    activeSlot,         // particleIndex -> slot in activeList (per remove O(1))

    deactivateParticle: (particleIndex: number) => {
      const gi = startIndex + particleIndex;

      // mark inactive (come prima)
      (_batchedPoints!.geometry.getAttribute('isActive') as THREE.BufferAttribute).array[gi] = 0;
      (_batchedPoints!.geometry.getAttribute('colorA') as THREE.BufferAttribute).array[gi] = 0;

      (_batchedPoints!.geometry.getAttribute('isActive') as THREE.BufferAttribute).needsUpdate = true;
      (_batchedPoints!.geometry.getAttribute('colorA') as THREE.BufferAttribute).needsUpdate = true;

      // ---- NEW: ritorna nello stack degli indici liberi ----
      instanceData.freeList[instanceData.freeTop++] = particleIndex;

      // ---- NEW: rimuovi dalla active list (swap-remove O(1)) ----
      const slot = instanceData.activeSlot[particleIndex];
      if (slot !== -1) {
        const lastParticleIndex = instanceData.activeList[instanceData.activeCount - 1];

        instanceData.activeList[slot] = lastParticleIndex;
        instanceData.activeSlot[lastParticleIndex] = slot;

        instanceData.activeCount--;
        instanceData.activeSlot[particleIndex] = -1;
      }
    },

    activateParticle: ({
      particleIndex,
      activationTime,
      position,
    }: {
      particleIndex: number;
      activationTime: number;
      position: Required<Point3D>;
    }) => {
      const gi = startIndex + particleIndex;

      const birthTimeAttr = _batchedPoints!.geometry.getAttribute('birthTime') as THREE.BufferAttribute;
      birthTimeAttr.array[gi] = activationTime; // ms
      birthTimeAttr.needsUpdate = true;

      const startFrameAttr = _batchedPoints!.geometry.getAttribute('startFrame') as THREE.BufferAttribute;

      // totale frame in atlas
      const tsa = (normalizedConfig as any).textureSheetAnimation;
      const tiles = tsa?.tiles ?? new THREE.Vector2(1, 1);
      const frames = Math.max(1, Math.floor(tiles.x * tiles.y));

      // Range per-system (stesso significato dello shader: inclusive, end=-1 => frames-1)
      const range = tsa?.range ?? {};
      let rangeStart = Math.floor((range.start ?? 0));
      let rangeEnd = (range.end == null || range.end < 0) ? (frames - 1) : Math.floor(range.end);

      rangeStart = Math.max(0, Math.min(rangeStart, frames - 1));
      rangeEnd   = Math.max(0, Math.min(rangeEnd, frames - 1));

      const rangeLen = Math.max(1, rangeEnd - rangeStart + 1);

      // startFrame deve essere RELATIVO al range (0..rangeLen-1)
      const baseStart = Math.floor(tsa?.startFrame ?? 0);

      // Opzione 1: clamp dentro rangeLen
      const baseRel = ((baseStart % rangeLen) + rangeLen) % rangeLen;

      // // Opzione 2: random relativo (consigliata per spezzare pattern)
      // const rel = (baseRel + Math.floor(Math.random() * rangeLen)) % rangeLen;

      startFrameAttr.array[gi] = baseRel;
      startFrameAttr.needsUpdate = true;

      const positionAttr = _batchedPoints!.geometry.getAttribute('position') as THREE.BufferAttribute;
      const isActiveAttr2 = _batchedPoints!.geometry.getAttribute('isActive') as THREE.BufferAttribute;
      const lifetimeAttr2 = _batchedPoints!.geometry.getAttribute('lifetime') as THREE.BufferAttribute;
      const rotationAttr = _batchedPoints!.geometry.getAttribute('rotation') as THREE.BufferAttribute;
      const startLifetimeAttr2 = _batchedPoints!.geometry.getAttribute('startLifetime') as THREE.BufferAttribute;
      const sizeAttr = _batchedPoints!.geometry.getAttribute('size') as THREE.BufferAttribute;

      // ===== FIX 1: spawnOffset + shapeOffset (old editor behavior) =====
      const sp = instanceData.startPositions[particleIndex] as THREE.Vector3;
      positionAttr.array[gi * 3 + 0] = (position.x || 0) + sp.x;
      positionAttr.array[gi * 3 + 1] = (position.y || 0) + sp.y;
      positionAttr.array[gi * 3 + 2] = (position.z || 0) + sp.z;

      isActiveAttr2.array[gi] = 1;
      lifetimeAttr2.array[gi] = 0;

      rotationAttr.array[gi] = calculateValue(
        generalData.particleSystemId,
        startRotation,
        generalData.normalizedLifetimePercentage
      );

      generalData.creationTimes[particleIndex] = activationTime;

      if ((generalData.noise as any).offsets) (generalData.noise as any).offsets[particleIndex] = Math.random() * 100;

      const colorRandomRatio = Math.random();
      const colorRAttr = _batchedPoints!.geometry.getAttribute('colorR') as THREE.BufferAttribute;
      const colorGAttr = _batchedPoints!.geometry.getAttribute('colorG') as THREE.BufferAttribute;
      const colorBAttr = _batchedPoints!.geometry.getAttribute('colorB') as THREE.BufferAttribute;
      const colorAAttr = _batchedPoints!.geometry.getAttribute('colorA') as THREE.BufferAttribute;

      colorRAttr.array[gi] = startColor.min!.r! + colorRandomRatio * (startColor.max!.r! - startColor.min!.r!);
      colorGAttr.array[gi] = startColor.min!.g! + colorRandomRatio * (startColor.max!.g! - startColor.min!.g!);
      colorBAttr.array[gi] = startColor.min!.b! + colorRandomRatio * (startColor.max!.b! - startColor.min!.b!);

      (generalData.startValues as any).startOpacity[particleIndex] = calculateValue(
        generalData.particleSystemId,
        startOpacity,
        generalData.normalizedLifetimePercentage
      );
      colorAAttr.array[gi] = (generalData.startValues as any).startOpacity[particleIndex];

      startLifetimeAttr2.array[gi] =
        calculateValue(generalData.particleSystemId, startLifetime, generalData.normalizedLifetimePercentage) * 1000;

      (generalData.startValues as any).startSize[particleIndex] = calculateValue(
        generalData.particleSystemId,
        startSize,
        generalData.normalizedLifetimePercentage
      );
      sizeAttr.array[gi] = (generalData.startValues as any).startSize[particleIndex];

      if (rotOLActive && (generalData.lifetimeValues as any).rotationOverLifetime) {
        (generalData.lifetimeValues as any).rotationOverLifetime[particleIndex] = THREE.MathUtils.randFloat(
          rotationOverLifetime.min!,
          rotationOverLifetime.max!
        );
      }

      const emitterIndexAttr = _batchedPoints!.geometry.getAttribute('emitterIndex') as THREE.BufferAttribute;
      emitterIndexAttr.array[gi] = instanceData.instanceIndex;

      applyModifiers({
        delta: 0,
        generalData,
        normalizedConfig,
        attributes: _batchedPoints!.geometry.attributes as any,
        particleLifetimePercentage: 0,
        particleIndex,
        globalIndex: gi,
      });

      positionAttr.needsUpdate = true;
      isActiveAttr2.needsUpdate = true;
      lifetimeAttr2.needsUpdate = true;
      rotationAttr.needsUpdate = true;
      startLifetimeAttr2.needsUpdate = true;
      sizeAttr.needsUpdate = true;

      colorRAttr.needsUpdate = true;
      colorGAttr.needsUpdate = true;
      colorBAttr.needsUpdate = true;
      colorAAttr.needsUpdate = true;

      emitterIndexAttr.needsUpdate = true;
    },
  };

  createdParticleSystems.push(instanceData);

  const resumeEmitter = () => (generalData.isEnabled = true);
  const pauseEmitter = () => (generalData.isEnabled = false);
  const dispose = () => destroyParticleSystem(generalData.particleSystemId);

  return {
    instance: _batchedPoints,
    generalData,
    resumeEmitter,
    pauseEmitter,
    dispose,
  } as any;
};

export const updateParticleSystems = ({ now, delta, elapsed }: CycleData) => {
  if (!_batchedPoints || !_batchedMaterial) return;

  _batchedMaterial.uniforms.elapsed.value = now; // ms

  createdParticleSystems.forEach((props) => {
    const {
      instanceIndex,
      onUpdate,
      generalData,
      onComplete,
      creationTime,
      duration,
      looping,
      emission,
      normalizedConfig,
      velocities,
      startIndex,
      maxParticles,
      deactivateParticle,
      activateParticle,
      simulationSpace,
      gravity,
    } = props;

    const lifetime = now - creationTime;
    const durationMs = (duration ?? 0) * 1000;

    generalData.normalizedLifetimePercentage =
      duration > 0 ? Math.max(Math.min((lifetime % durationMs) / durationMs, 1), 0) : 0;

    const {
      lastWorldPosition,
      currentWorldPosition,
      worldPositionChange,
      lastWorldQuaternion,
      worldQuaternion,
      worldEuler,
      gravityVelocity,
    } = generalData;

    if (_getEmitterTRS(instanceIndex, _tmpPos, _tmpQuat, _tmpScale)) {
      currentWorldPosition.copy(_tmpPos);
      worldQuaternion.copy(_tmpQuat);
    }

    if (lastWorldPosition.x !== -99999) {
      worldPositionChange.set(
        currentWorldPosition.x - lastWorldPosition.x,
        currentWorldPosition.y - lastWorldPosition.y,
        currentWorldPosition.z - lastWorldPosition.z
      );
    }
    generalData.distanceFromLastEmitByDistance += worldPositionChange.length();
    lastWorldPosition.copy(currentWorldPosition);

    if (
      (lastWorldQuaternion as any).x === -99999 ||
      lastWorldQuaternion.x !== worldQuaternion.x ||
      lastWorldQuaternion.y !== worldQuaternion.y ||
      lastWorldQuaternion.z !== worldQuaternion.z
    ) {
      worldEuler.setFromQuaternion(worldQuaternion);
      lastWorldQuaternion.copy(worldQuaternion);

      gravityVelocity.set(lastWorldPosition.x, lastWorldPosition.y + gravity, lastWorldPosition.z);

      if (_readEmitterMatrix(instanceIndex, _tmpMat)) {
        _tmpMatInv.copy(_tmpMat).invert();
        gravityVelocity.applyMatrix4(_tmpMatInv);
      }
    }

    // ========== EMISSIONE ==========
    if (generalData.isEnabled && (looping || duration === 0 || lifetime < durationMs)) {
      const rateOverTime = Math.max(
        0,
        calculateValue(generalData.particleSystemId, emission.rateOverTime, generalData.normalizedLifetimePercentage)
      );

      if (rateOverTime > 0) {
        const timeSinceLastEmitMs = now - props.lastEmissionTime;

        const totalToEmit = (timeSinceLastEmitMs * rateOverTime) / 1000 + (props.emissionCarry || 0);
        const emitCount = Math.floor(totalToEmit);
        props.emissionCarry = totalToEmit - emitCount;

        for (let e = 0; e < emitCount; e++) {
          // O(1): prendi uno slot libero
          if (props.freeTop <= 0) break;
          const freeIndex = props.freeList[--props.freeTop];

          // NO alloc per spawn
          _shapeOffset.set(0, 0, 0);
          _spawnedVelocity.set(0, 0, 0);

          // ROTATION FIX: apply baseQuat (config rotation) + emitter TRS rotation if WORLD
          const baseQuat: THREE.Quaternion | undefined = (generalData as any)._baseQuat;

          if (simulationSpace === SimulationSpace.WORLD) {
            if (_getEmitterTRS(instanceIndex, _tmpPos, _tmpQuat, _tmpScale)) {
              generalData.wrapperQuaternion.copy(_tmpQuat);
              if (baseQuat) generalData.wrapperQuaternion.multiply(baseQuat);
            } else {
              // no alloc
              generalData.wrapperQuaternion.copy(baseQuat ?? _tmpQuat.identity());
            }
          } else {
            // LOCAL: baseQuat invertito senza clone/alloc
            if (baseQuat) _invBaseQuat.copy(baseQuat).invert();
            else _invBaseQuat.identity();

            generalData.wrapperQuaternion.copy(_invBaseQuat);
            generalData.wrapperQuaternion.multiply(worldQuaternion); // oppure _tmpQuat
          }

          // shapeOffset + spawnedVelocity
          calculatePositionAndVelocity(
            generalData,
            normalizedConfig.shape,
            normalizedConfig.startSpeed,
            _shapeOffset,
            _spawnedVelocity
          );

          // store for this particle index
          (props.startPositions[freeIndex] as THREE.Vector3).copy(_shapeOffset);
          velocities[freeIndex].copy(_spawnedVelocity);

          // spawn offset only (WORLD uses emitter pos; LOCAL is 0)
          const spawnOffset =
            simulationSpace === SimulationSpace.WORLD
              ? { x: lastWorldPosition.x, y: lastWorldPosition.y, z: lastWorldPosition.z }
              : { x: 0, y: 0, z: 0 };

          activateParticle({
            particleIndex: freeIndex,
            activationTime: now,
            position: spawnOffset,
          });

          // NEW: aggiungi all’active list
          props.activeSlot[freeIndex] = props.activeCount;
          props.activeList[props.activeCount++] = freeIndex;

          props.lastEmissionTime = now;
        }
      }
    }

    // ========== UPDATE PARTICELLE ==========
    const positionAttr = _batchedPoints!.geometry.getAttribute('position') as THREE.BufferAttribute;
    const isActiveAttr = _batchedPoints!.geometry.getAttribute('isActive') as THREE.BufferAttribute;
    const lifetimeAttr = _batchedPoints!.geometry.getAttribute('lifetime') as THREE.BufferAttribute;
    const startLifetimeAttr = _batchedPoints!.geometry.getAttribute('startLifetime') as THREE.BufferAttribute;

    const sizeAttr = _batchedPoints!.geometry.getAttribute('size') as THREE.BufferAttribute;
    const rotationAttr = _batchedPoints!.geometry.getAttribute('rotation') as THREE.BufferAttribute;
    const colorAAttr = _batchedPoints!.geometry.getAttribute('colorA') as THREE.BufferAttribute;

    let anyPositionChanged = false;
    let anyLifetimeChanged = false;
    let anyVisualChanged = false;

    for (let k = 0; k < props.activeCount; k++) {
      const i = props.activeList[k];
      const gi = startIndex + i;

      const particleLifetimeMs = now - generalData.creationTimes[i];
      const startLifetimeMs = startLifetimeAttr.array[gi];

      if (particleLifetimeMs > startLifetimeMs) {
        deactivateParticle(i);
        k--; // swap-remove: riprocessa lo slot k
        continue;
      }

      const velocity = velocities[i];

      velocity.x -= gravityVelocity.x * delta;
      velocity.y -= gravityVelocity.y * delta;
      velocity.z -= gravityVelocity.z * delta;

      const positionIndex = gi * 3;
      const positionArr = positionAttr.array as any as number[];

      if (simulationSpace === SimulationSpace.WORLD) {
        positionArr[positionIndex] -= worldPositionChange.x;
        positionArr[positionIndex + 1] -= worldPositionChange.y;
        positionArr[positionIndex + 2] -= worldPositionChange.z;
      }

      positionArr[positionIndex] += velocity.x * delta;
      positionArr[positionIndex + 1] += velocity.y * delta;
      positionArr[positionIndex + 2] += velocity.z * delta;

      anyPositionChanged = true;

      lifetimeAttr.array[gi] = particleLifetimeMs;
      anyLifetimeChanged = true;

      const particleLifetimePercentage = startLifetimeMs > 0 ? particleLifetimeMs / startLifetimeMs : 0;

      applyModifiers({
        delta,
        generalData,
        normalizedConfig,
        attributes: _batchedPoints!.geometry.attributes as any,
        particleLifetimePercentage,
        particleIndex: i,
        globalIndex: gi,
      });

      anyVisualChanged = true;
    }

    if (anyPositionChanged) positionAttr.needsUpdate = true;
    if (anyLifetimeChanged) lifetimeAttr.needsUpdate = true;

    if (anyVisualChanged) {
      sizeAttr.needsUpdate = true;
      rotationAttr.needsUpdate = true;
      colorAAttr.needsUpdate = true;
    }

    props.iterationCount = (props.iterationCount ?? 0) + 1;

    if (onUpdate) {
      onUpdate({
        particleSystem: _batchedPoints!,
        delta,
        elapsed,
        lifetime,
        normalizedLifetime: generalData.normalizedLifetimePercentage * (duration ?? 0) * 1000,
        iterationCount: props.iterationCount,
      });
    } else if (!looping && lifetime >= durationMs && onComplete) {
      onComplete({ particleSystem: _batchedPoints! });
    }
  });
};

export const getBatchedPoints = () => _batchedPoints;
export const getInstanceData = () => _instanceData;
export const _debugGetEmitters = () => createdParticleSystems;

export const setEmitterMatrix = (particleSystemId: number, matrix: THREE.Matrix4) => {
  if (!_batchedPoints || !_batchedMaterial) return;
  const meta = _instanceData.get(particleSystemId);
  if (!meta) return;

  const instMatrixAttr = _batchedPoints.geometry.getAttribute('instanceMatrix') as THREE.BufferAttribute;
  if (instMatrixAttr) {
    matrix.toArray(instMatrixAttr.array as any, meta.instanceIndex * 16);
    instMatrixAttr.needsUpdate = true;
  }

  const i = meta.instanceIndex;
  const e = matrix.elements;

  _batchedMaterial.uniforms.instanceMat0.value[i].set(e[0], e[1], e[2], e[3]);
  _batchedMaterial.uniforms.instanceMat1.value[i].set(e[4], e[5], e[6], e[7]);
  _batchedMaterial.uniforms.instanceMat2.value[i].set(e[8], e[9], e[10], e[11]);
  _batchedMaterial.uniforms.instanceMat3.value[i].set(e[12], e[13], e[14], e[15]);
};

export const setEmitterPosition = (particleSystemId: number, x: number, y: number, z: number) => {
  if (!_batchedPoints) return;
  const meta = _instanceData.get(particleSystemId);
  if (!meta) return;

  if (!_readEmitterMatrix(meta.instanceIndex, _tmpMat)) return;
  _tmpMat.decompose(_tmpPos, _tmpQuat, _tmpScale);

  _tmpPos.set(x, y, z);
  _tmpMat.compose(_tmpPos, _tmpQuat, _tmpScale);

  setEmitterMatrix(particleSystemId, _tmpMat);
};

export const setEmitterRotation = (particleSystemId: number, q: THREE.Quaternion) => {
  if (!_batchedPoints) return;
  const meta = _instanceData.get(particleSystemId);
  if (!meta) return;

  if (!_readEmitterMatrix(meta.instanceIndex, _tmpMat)) return;
  _tmpMat.decompose(_tmpPos, _tmpQuat, _tmpScale);

  _tmpQuat.copy(q);
  _tmpMat.compose(_tmpPos, _tmpQuat, _tmpScale);

  setEmitterMatrix(particleSystemId, _tmpMat);
};

export const setEmitterScale = (particleSystemId: number, sx: number, sy: number, sz: number) => {
  if (!_batchedPoints) return;
  const meta = _instanceData.get(particleSystemId);
  if (!meta) return;

  if (!_readEmitterMatrix(meta.instanceIndex, _tmpMat)) return;
  _tmpMat.decompose(_tmpPos, _tmpQuat, _tmpScale);

  _tmpScale.set(sx, sy, sz);
  _tmpMat.compose(_tmpPos, _tmpQuat, _tmpScale);

  setEmitterMatrix(particleSystemId, _tmpMat);
};

export { _batchedPoints as createParticleRenderObject, _instanceData };
