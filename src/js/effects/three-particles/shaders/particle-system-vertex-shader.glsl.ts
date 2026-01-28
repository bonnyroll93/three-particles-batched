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

  varying vec2 vRotSC;         // (sin, cos)

  // Spritesheet: offset (in UV 0..1) del frame e scala della cella
  varying vec2 vTileOffset;
  varying vec2 vTileScale;

  uniform float fps;
  uniform bool useFPSForFrameIndex;
  uniform vec2 tiles;

  #include <common>
  #include <logdepthbuf_pars_vertex>

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

    // sin/cos una sola volta per particella
    float s = sin(rotation);
    float c = cos(rotation);
    vRotSC = vec2(s, c);

    // ---------------------------
    // SPRITESHEET / FLIPBOOK
    // ---------------------------
    float cols = max(tiles.x, 1.0);
    float rows = max(tiles.y, 1.0);
    float frames = cols * rows;

    // Dimensione cella (da usare nel fragment con gl_PointCoord)
    vTileScale = vec2(1.0 / cols, 1.0 / rows);

    // Frame iniziale per particella
    float frameIndex = floor(startFrame + 0.5);

    // Avanzamento frame
    if (frames > 1.0) {
      if (useFPSForFrameIndex) {
        // lifetime è in ms nel tuo sistema -> converti in secondi
        float adv = (fps <= 0.0) ? 0.0 : max((lifetime / 1000.0) * fps, 0.0);
        frameIndex += floor(adv);
      } else {
        float t = (startLifetime > 0.0) ? clamp(lifetime / startLifetime, 0.0, 1.0) : 0.0;
        frameIndex += clamp(floor(t * frames), 0.0, frames - 1.0);
      }

      // wrap
      frameIndex = mod(frameIndex, frames);
    } else {
      frameIndex = 0.0;
    }

    float spriteXIndex = mod(frameIndex, cols);
    float spriteYIndex = floor(frameIndex / cols);

    // Offset UV della cella selezionata.
    // Nota: qui NON faccio flip di Y.
    // Se vedi che le tile risultano invertite verticalmente, cambia spriteYIndex con (rows - 1.0 - spriteYIndex).
    vTileOffset = vec2(spriteXIndex, spriteYIndex) * vTileScale;

    // ---------------------------
    // TRASFORMAZIONE EMITTER
    // ---------------------------
    int sys = int(emitterIndex + 0.5);
    sys = clamp(sys, 0, MAX_SYSTEMS - 1);

    vec3 p = position;

    // LOCAL => applico la matrice dell’emitter; WORLD => position è già in world
    if (instanceSimulationSpace[sys] < 0.5) {
      p = (getEmitterMatrix(sys) * vec4(p, 1.0)).xyz;
    }

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);

    float computedSize = size * (100.0 / max(0.0001, length(mvPosition.xyz)));
    gl_PointSize = clamp(computedSize, 0.0, 128.0);

    gl_Position = projectionMatrix * mvPosition;

    #include <logdepthbuf_vertex>
  }
`;
export default ParticleSystemVertexShader;
