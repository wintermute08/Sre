// 원본 GLB(Blender 전달본) → 웹용 GLB
// - 국소 변형은 셰이더로 하므로 Press_* 모프는 제거하고 Squeeze / Pull_* 만 남김
// - meshopt 압축으로 모바일 다운로드 크기 축소
// 사용: node scripts/optimize-model.mjs <원본.glb> public/models/slang_soap.glb
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { meshopt, prune } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

const [src, dst] = process.argv.slice(2);
const KEEP = ['Squeeze', 'Pull_Left', 'Pull_Right'];

await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(src);

for (const mesh of doc.getRoot().listMeshes()) {
  const names = mesh.getExtras().targetNames ?? [];
  const keepIdx = names.map((n, i) => (KEEP.includes(n) ? i : -1)).filter((i) => i >= 0);
  for (const prim of mesh.listPrimitives()) {
    prim.listTargets().forEach((t, i) => {
      if (!keepIdx.includes(i)) prim.removeTarget(t);
    });
  }
  mesh.setWeights(keepIdx.map(() => 0));
  mesh.setExtras({ ...mesh.getExtras(), targetNames: keepIdx.map((i) => names[i]) });
}

await doc.transform(prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
await io.write(dst, doc);
console.log('written', dst);
