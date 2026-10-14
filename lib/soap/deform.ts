import * as THREE from 'three';

// 손가락 위치 중심의 국소 눌림을 GPU에서 계산한다.
// 미리 만든 모프(Press_*) 5방향 섞기 대신, 임의 위치를 정확히 누를 수 있게 하는 부분.
// 단위: 미터, 비누 로컬 좌표 (GLB 원본 크기 104 × 28 × 66 mm 유지)

export const MAX_DENTS = 5;

export type DentUniforms = {
  uDentC: { value: THREE.Vector4[] }; // xyz: 누른 중심, w: 깊이
  uDentN: { value: THREE.Vector4[] }; // xyz: 누르는 면의 법선, w: 반경
  uDentCount: { value: number };
};

export function createDentUniforms(): DentUniforms {
  return {
    uDentC: { value: Array.from({ length: MAX_DENTS }, () => new THREE.Vector4()) },
    uDentN: { value: Array.from({ length: MAX_DENTS }, () => new THREE.Vector4(0, 1, 0, 0.012)) },
    uDentCount: { value: 0 },
  };
}

const DEFORM_GLSL = /* glsl */ `
#define MAX_DENTS ${MAX_DENTS}
uniform vec4 uDentC[MAX_DENTS];
uniform vec4 uDentN[MAX_DENTS];
uniform int uDentCount;

vec3 deformSoap(vec3 p) {
  vec3 o = p;
  for (int i = 0; i < MAX_DENTS; i++) {
    if (i >= uDentCount) break;
    vec4 C = uDentC[i];
    vec4 N = uDentN[i];
    float d = C.w;
    if (d <= 1e-6) continue;
    vec3 n = N.xyz;
    float r = N.w;
    vec3 v = p - C.xyz;
    float h = dot(v, n);
    vec3 lat = v - h * n;
    float l2 = dot(lat, lat);
    float rr = r * r;
    // 손가락 끝처럼 바닥이 살짝 평평한 오목
    float f = exp(-pow(l2 / rr, 1.25));
    // 반대 면으로 갈수록 영향이 줄어듦 (두께 28mm 기준)
    float g = exp(min(h, 0.0) * 75.0);
    o -= n * (d * f * g);
    // 밀려난 말랑이가 옆으로 퍼지고 둘레가 살짝 솟음
    float l = sqrt(l2) + 1e-6;
    float ring = (l / r) * exp(-l2 / (rr * 1.6));
    o += (lat / l) * (d * 0.3 * ring * g);
    o += n * (d * 0.14 * ring * ring * g);
  }
  return o;
}
`;

/** GLB 재질을 받아 눌림 셰이더가 들어간 비누 재질로 바꾼다 */
export function createSoapMaterial(source: THREE.MeshStandardMaterial, uniforms: DentUniforms) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: source.color.clone(),
    roughness: 0.42,
    metalness: 0,
    normalMap: source.normalMap,
    normalScale: source.normalScale.clone().multiplyScalar(1.6), // 각인을 조금 더 또렷하게
    // 뽀얀 분가루 느낌
    sheen: 0.25,
    sheenRoughness: 0.8,
    sheenColor: new THREE.Color('#ffffff'),
    clearcoat: 0.3,
    clearcoatRoughness: 0.45,
    side: THREE.FrontSide,
  });

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${DEFORM_GLSL}`)
      .replace(
        '#include <morphnormal_vertex>',
        /* glsl */ `#include <morphnormal_vertex>
        if (uDentCount > 0) {
          vec3 n0 = normalize(objectNormal);
          vec3 tt = normalize(cross(n0, abs(n0.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
          vec3 bb = cross(n0, tt);
          const float e = 0.0006;
          vec3 p0 = deformSoap(position);
          vec3 d1 = deformSoap(position + tt * e) - p0;
          vec3 d2 = deformSoap(position + bb * e) - p0;
          objectNormal = normalize(cross(d1, d2));
        }`,
      )
      .replace(
        '#include <project_vertex>',
        /* glsl */ `if (uDentCount > 0) transformed = deformSoap(transformed);
        #include <project_vertex>`,
      );
  };
  // 같은 셰이더 프로그램 재사용
  mat.customProgramCacheKey = () => 'slang-soap-deform';
  return mat;
}
