import * as THREE from 'three';

import { calculateValue } from './three-particles-utils.js';
import type { GeneralData, NormalizedParticleSystemConfig } from './types.js';

const noiseInput = new THREE.Vector3(0, 0, 0);
const orbitalEuler = new THREE.Euler();

type ApplyModifiersParams = {
  delta: number;
  generalData: GeneralData;
  normalizedConfig: NormalizedParticleSystemConfig;
  attributes: THREE.NormalBufferAttributes;
  particleLifetimePercentage: number;
  particleIndex: number;   // local index
  globalIndex?: number;    // optional global index for batched buffers
};

export const applyModifiers = (params: ApplyModifiersParams) => {
  const {
    delta,
    generalData,
    normalizedConfig,
    attributes,
    particleLifetimePercentage,
    particleIndex,
    globalIndex,
  } = params;

  const li = particleIndex;
  const gi = globalIndex ?? particleIndex;

  const {
    particleSystemId,
    startValues,
    lifetimeValues,
    linearVelocityData,
    orbitalVelocityData,
    noise,
  } = generalData;

  const positionIndex = gi * 3;
  const positionArr = attributes.position.array;

  if (linearVelocityData) {
    const { speed, valueModifiers } = linearVelocityData[li];

    const normalizedXSpeed = valueModifiers.x
      ? valueModifiers.x(particleLifetimePercentage)
      : speed.x;

    const normalizedYSpeed = valueModifiers.y
      ? valueModifiers.y(particleLifetimePercentage)
      : speed.y;

    const normalizedZSpeed = valueModifiers.z
      ? valueModifiers.z(particleLifetimePercentage)
      : speed.z;

    positionArr[positionIndex] += normalizedXSpeed * delta;
    positionArr[positionIndex + 1] += normalizedYSpeed * delta;
    positionArr[positionIndex + 2] += normalizedZSpeed * delta;

    attributes.position.needsUpdate = true;
  }

  if (orbitalVelocityData) {
    const { speed, positionOffset, valueModifiers } = orbitalVelocityData[li];

    positionArr[positionIndex] -= positionOffset.x;
    positionArr[positionIndex + 1] -= positionOffset.y;
    positionArr[positionIndex + 2] -= positionOffset.z;

    const normalizedXSpeed = valueModifiers.x
      ? valueModifiers.x(particleLifetimePercentage)
      : speed.x;

    const normalizedYSpeed = valueModifiers.y
      ? valueModifiers.y(particleLifetimePercentage)
      : speed.y;

    const normalizedZSpeed = valueModifiers.z
      ? valueModifiers.z(particleLifetimePercentage)
      : speed.z;

    orbitalEuler.set(
      normalizedXSpeed * delta,
      normalizedZSpeed * delta,
      normalizedYSpeed * delta
    );

    positionOffset.applyEuler(orbitalEuler);

    positionArr[positionIndex] += positionOffset.x;
    positionArr[positionIndex + 1] += positionOffset.y;
    positionArr[positionIndex + 2] += positionOffset.z;

    attributes.position.needsUpdate = true;
  }

  if (normalizedConfig.sizeOverLifetime.isActive) {
    const multiplier = calculateValue(
      particleSystemId,
      normalizedConfig.sizeOverLifetime.lifetimeCurve,
      particleLifetimePercentage
    );

    attributes.size.array[gi] = startValues.startSize[li] * multiplier;
    attributes.size.needsUpdate = true;
  }

  if (normalizedConfig.opacityOverLifetime.isActive) {
    const multiplier = calculateValue(
      particleSystemId,
      normalizedConfig.opacityOverLifetime.lifetimeCurve,
      particleLifetimePercentage
    );

    attributes.colorA.array[gi] = startValues.startOpacity[li] * multiplier;
    attributes.colorA.needsUpdate = true;
  }

  if (lifetimeValues.rotationOverLifetime) {
    attributes.rotation.array[gi] +=
      lifetimeValues.rotationOverLifetime[li] * delta * 0.02;
    attributes.rotation.needsUpdate = true;
  }

  if (noise.isActive) {
    const {
      sampler,
      strength,
      offsets,
      positionAmount,
      rotationAmount,
      sizeAmount,
    } = noise;

    const noisePosition =
      (particleLifetimePercentage + (offsets ? offsets[li] : 0)) * 10 * strength;

    const noisePower = 0.15 * strength;

    // X
    noiseInput.set(noisePosition, 0, 0);
    let noiseOnPosition = sampler!.get3(noiseInput);
    positionArr[positionIndex] += noiseOnPosition * noisePower * positionAmount;

    if (rotationAmount !== 0) {
      attributes.rotation.array[gi] +=
        noiseOnPosition * noisePower * rotationAmount;
      attributes.rotation.needsUpdate = true;
    }

    if (sizeAmount !== 0) {
      attributes.size.array[gi] += noiseOnPosition * noisePower * sizeAmount;
      attributes.size.needsUpdate = true;
    }

    // Y
    noiseInput.set(noisePosition, noisePosition, 0);
    noiseOnPosition = sampler!.get3(noiseInput);
    positionArr[positionIndex + 1] +=
      noiseOnPosition * noisePower * positionAmount;

    // Z
    noiseInput.set(noisePosition, noisePosition, noisePosition);
    noiseOnPosition = sampler!.get3(noiseInput);
    positionArr[positionIndex + 2] +=
      noiseOnPosition * noisePower * positionAmount;

    attributes.position.needsUpdate = true;
    
  }
};
