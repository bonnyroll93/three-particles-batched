const ParticleSystemVertexShader = /* glsl */ `
  attribute float size;
  attribute float colorR;
  attribute float colorG;
  attribute float colorB;
  attribute float colorA;
  attribute float lifetime;
  attribute float startLifetime;
  attribute float rotation;
  attribute float startFrame;

  attribute float emitterIndex;

  varying vec4 vColor;
  varying float vLifetime;
  varying float vStartLifetime;
  varying float vRotation;
  varying float vStartFrame;

  #include <common>
  #include <logdepthbuf_pars_vertex>

  // MAX_SYSTEMS arriva da ShaderMaterial.defines
  uniform float instanceSimulationSpace[MAX_SYSTEMS]; // 0 = LOCAL, 1 = WORLD
  uniform vec4 instanceMat0[MAX_SYSTEMS];
  uniform vec4 instanceMat1[MAX_SYSTEMS];
  uniform vec4 instanceMat2[MAX_SYSTEMS];
  uniform vec4 instanceMat3[MAX_SYSTEMS];

  mat4 getEmitterMatrix(int i) {
    return mat4(
      instanceMat0[i],
      instanceMat1[i],
      instanceMat2[i],
      instanceMat3[i]
    );
  }

  void main() {
    vColor = vec4(colorR, colorG, colorB, colorA);
    vLifetime = lifetime;
    vStartLifetime = startLifetime;
    vRotation = rotation;
    vStartFrame = startFrame;

    int sys = int(emitterIndex + 0.5);
    sys = clamp(sys, 0, MAX_SYSTEMS - 1);

    vec3 p = position;

    // LOCAL => applico la matrice dell’emitter; WORLD => position è già in world
    if (instanceSimulationSpace[sys] < 0.5) {
      p = (getEmitterMatrix(sys) * vec4(p, 1.0)).xyz;
    }

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);

    // (opzionale) clamp per evitare point enormi se la camera è troppo vicina
    gl_PointSize = size * (100.0 / max(0.0001, length(mvPosition.xyz)));

    gl_Position = projectionMatrix * mvPosition;

    #include <logdepthbuf_vertex>
  }
`;

export default ParticleSystemVertexShader;
