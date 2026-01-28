const ParticleSystemFragmentShader = /* glsl */ `
  uniform sampler2D map;
  uniform bool discardBackgroundColor;
  uniform vec3 backgroundColor;
  uniform float backgroundColorTolerance;

  varying vec4 vColor;
  varying vec2 vRotSC;        // (sin, cos) dal vertex
  varying vec2 vTileOffset;   // offset UV (0..1) della cella
  varying vec2 vTileScale;    // scale UV (0..1) della cella: (1/cols, 1/rows)

  #include <common>
  #include <logdepthbuf_pars_fragment>

  void main() {
    vec2 center = vec2(0.5, 0.5);
    vec2 p = gl_PointCoord - center;

    // rotazione usando sin/cos precomputati
    float s = vRotSC.x;
    float c = vRotSC.y;
    vec2 pr = vec2(
      c * p.x + s * p.y,
      -s * p.x + c * p.y
    );

    // UV nello sprite (0..1) dopo rotazione attorno al centro
    vec2 uvSprite = pr + center;

    // Spritesheet UV: prendi la cella (offset) e scala l’uv dentro la cella
    vec2 uvAtlas = vTileOffset + uvSprite * vTileScale;

    vec4 tex = texture2D(map, uvAtlas);
    vec4 outColor = vColor * tex;

    // Alpha mask circolare SOFT (no discard)
    float r2 = dot(pr, pr);

    float feather = 0.04;
    float inner = 0.25 - feather;
    float outer = 0.25;

    float mask = 1.0 - smoothstep(inner, outer, r2);
    outColor.a *= mask;

    if (discardBackgroundColor) {
      float d = length(tex.rgb - backgroundColor.rgb);
      float keep = step(backgroundColorTolerance, d);
      outColor.a *= keep;
    }

    gl_FragColor = outColor;

    #include <logdepthbuf_fragment>
  }
`;
export default ParticleSystemFragmentShader;
