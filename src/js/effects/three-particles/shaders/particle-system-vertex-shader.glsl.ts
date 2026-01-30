const ParticleSystemVertexShader = /* glsl */ `
  attribute float size;
  attribute float colorR;
  attribute float colorG;
  attribute float colorB;
  attribute float colorA;
  attribute float lifetime;       // age ms (lo lasciamo, ma FPS userà elapsed-birthTime)
  attribute float startLifetime;  // ms
  attribute float rotation;
  attribute float startFrame;     // RELATIVO al range (0..rangeLen-1) come CPU
  attribute float emitterIndex;

  // NEW: tempo di nascita in ms (activationTime)
  attribute float birthTime;

  varying vec4 vColor;
  varying float vLifetime;
  varying float vStartLifetime;

  varying vec2 vRotSC;         // (sin, cos)

  // Spritesheet: offset (in UV 0..1) del frame e scala della cella
  varying vec2 vTileOffset;
  varying vec2 vTileScale;

  uniform float fps;
  uniform float instanceUseFPSForFrameIndex[MAX_SYSTEMS]; // 0=Lifetime, 1=FPS
  uniform vec2 tiles;

  // NEW: tempo globale in ms (già lo aggiorni lato CPU)
  uniform float elapsed;

  #include <common>
  #include <logdepthbuf_pars_vertex>

  uniform float instanceSimulationSpace[MAX_SYSTEMS]; // 0 = LOCAL, 1 = WORLD
  uniform vec4 instanceMat0[MAX_SYSTEMS];
  uniform vec4 instanceMat1[MAX_SYSTEMS];
  uniform vec4 instanceMat2[MAX_SYSTEMS];
  uniform vec4 instanceMat3[MAX_SYSTEMS];

  // ---------------------------
  // FLIPBOOK CONTROL (per system)
  // ---------------------------
  // 0 = LOOP, 1 = ONCE, 2 = PINGPONG, 3 = CLAMP
  uniform float instanceFlipbookMode[MAX_SYSTEMS];

  // Range di frame (inclusive). Se end < 0 => usa frames-1
  uniform float instanceFlipbookRangeStart[MAX_SYSTEMS];
  uniform float instanceFlipbookRangeEnd[MAX_SYSTEMS];

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

    vTileScale = vec2(1.0 / cols, 1.0 / rows);

    // system index
    int sys = int(emitterIndex + 0.5);
    sys = clamp(sys, 0, MAX_SYSTEMS - 1);

    // range start/end (inclusive)
    float rangeStart = floor(instanceFlipbookRangeStart[sys] + 0.5);
    float rangeEnd = instanceFlipbookRangeEnd[sys] < 0.0
      ? (frames - 1.0)
      : floor(instanceFlipbookRangeEnd[sys] + 0.5);

    rangeStart = clamp(rangeStart, 0.0, max(0.0, frames - 1.0));
    rangeEnd   = clamp(rangeEnd,   0.0, max(0.0, frames - 1.0));

    // se start > end, fallback: usa start come singolo frame
    float rangeLen = max(1.0, rangeEnd - rangeStart + 1.0);

    // startFrame è RELATIVO al range: normalizziamo sempre dentro rangeLen
    float startRel = mod(floor(startFrame + 0.5), rangeLen);
    float baseFrame = rangeStart + startRel;

    // tempo dall’attivazione (ms)
    float ageMs = max(0.0, elapsed - birthTime);

    // Avanzamento frame (raw) dentro al range
    float adv = 0.0;

    if (rangeLen > 1.0) {
      if (instanceUseFPSForFrameIndex[sys] > 0.5) {
        // FPS: usa tempo reale dalla nascita, non lifetime attr
        float ageSec = ageMs / 1000.0;
        adv = (fps <= 0.0) ? 0.0 : floor(ageSec * fps);
      } else {
        // LIFETIME: distribuzione uniforme sulla vita
        float t01 = (startLifetime > 0.0) ? clamp(ageMs / startLifetime, 0.0, 1.0) : 0.0;

        // Nota: per LOOP/PINGPONG vogliamo periodicità; per ONCE/CLAMP vogliamo arrivare a end.
        float mode = instanceFlipbookMode[sys];
        float span = (mode < 0.5 || (mode >= 1.5 && mode < 2.5)) ? rangeLen : (rangeLen - 1.0);
        adv = floor(t01 * max(1.0, span));
      }
    }

    float raw = baseFrame + adv;

    // Applica loopMode sul range
    float mode = instanceFlipbookMode[sys];
    float frameIndex = raw;

    if (frames <= 1.0) {
      frameIndex = 0.0;
    } else if (mode < 0.5) {
      // LOOP
      frameIndex = rangeStart + mod((raw - rangeStart), rangeLen);
    } else if (mode < 1.5) {
      // ONCE (si ferma su end)
      frameIndex = clamp(raw, rangeStart, rangeEnd);
    } else if (mode < 2.5) {
      // PINGPONG (rangeStart..rangeEnd..rangeStart..)
      float period = max(1.0, 2.0 * rangeLen - 2.0);
      float x = mod((raw - rangeStart), period);
      float ping = (x <= (rangeLen - 1.0)) ? x : (period - x);
      frameIndex = rangeStart + ping;
    } else {
      // CLAMP (uguale a ONCE in questa implementazione)
      frameIndex = clamp(raw, rangeStart, rangeEnd);
    }

    float spriteXIndex = mod(frameIndex, cols);
    float spriteYIndex = floor(frameIndex / cols);

    // Offset UV della cella selezionata (no flip Y)
    vTileOffset = vec2(spriteXIndex, spriteYIndex) * vTileScale;

    // ---------------------------
    // TRASFORMAZIONE EMITTER
    // ---------------------------
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
