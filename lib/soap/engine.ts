import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CrunchAudio, type GrainKind } from './audio';
import { MAX_DENTS, createDentUniforms, createSoapMaterial, stampUniforms } from './deform';

// ---------- 튜닝 값 (미터, 초) ----------
export const TUNING = {
  depth: 0.0065,        // 최종 눌림 깊이 (두께 28mm의 약 23%)
  holdExtra: 0.1,       // 1.2초 이상 꾹 누르면 추가로 더 들어가는 비율 (조금만)
  firmStage: 0.45,      // 바삭하기 전 단단하게 버티는 깊이 비율
  crunchAt: 0.04,       // 합성음일 때 '바삭' 하며 꺼지는 시점(초). 녹음 소리는 클립마다 첫 '바삭'에 맞춤
  holdTime: 1.2,
  radius: 0.0105,       // 손가락 자국 반경 — 좁을수록 단단한 재질처럼 보임
  stiffness: 1600,      // 누를 때 스프링 — 단단하게 바로 반응
  damping: 1.0,         // 출렁임 없음 (1보다 작으면 젤리처럼 출렁)
  releaseDelay: 0.18,   // 손 떼고 눌린 채로 잠깐 버티는 시간
  recoverSlow: 0.45,    // 복원 초반 속도 — 아주 천천히, 쫀득하게
  recoverFast: 2.8,     // 복원 후반 속도
  recoverRamp: 1.4,     // 초반→후반 전환 시간 (95% 복원까지 약 1.8초)
  tiltMax: 0.35,        // 빈 곳 드래그로 기울일 수 있는 최대 각도(rad)
};

export const SOAP_TINTS = {
  ivory: '#e8ecdf',
  peach: '#f6d5c4',
  pink: '#f4c9d3',
  mint: '#cbe7da',
  lavender: '#dcd3f0',
} as const;
export type SoapTint = keyof typeof SOAP_TINTS;

/** 비누 색 → 녹음 그룹 (public/audio/clips.json 의 group) */
const TINT_SOUND_GROUP: Record<SoapTint, string | null> = {
  ivory: null,
  peach: 'orange',
  pink: 'pink',
  mint: 'green_white',
  lavender: 'blue',
};

export type EngineEvents = {
  onProgress?: (ratio: number) => void;
  onReady?: () => void;
  onError?: (message: string) => void;
  onPress?: () => void;
};

const ease = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

class Dent {
  center: THREE.Vector3;
  target: THREE.Vector3;
  normal: THREE.Vector3;
  targetNormal: THREE.Vector3;
  start: THREE.Vector3;
  radius = TUNING.radius;
  depth = 0;
  vel = 0;
  held = true;
  age = 0;
  releasedAt = 0;
  crunchAt = TUNING.crunchAt;
  // 소리: 지난 프레임 대비 변형량으로 알갱이를 만든다
  prevDepth = 0;
  prevCenter = new THREE.Vector3();
  grainAcc = 0;

  constructor(public pointerId: number, local: THREE.Vector3, normal: THREE.Vector3, public pan: number) {
    this.center = local.clone();
    this.target = local.clone();
    this.start = local.clone();
    this.prevCenter.copy(local);
    this.normal = normal.clone();
    this.targetNormal = normal.clone();
  }

  update(dt: number): boolean {
    this.age += dt;
    if (this.held) {
      this.center.lerp(this.target, ease(30, dt));
      this.normal.lerp(this.targetNormal, ease(20, dt)).normalize();
      const hold = Math.min(this.age / TUNING.holdTime, 1);
      // 1단계: 단단하게 버팀 → 2단계: '바삭' 하며 꺼짐 → 그 뒤로는 거의 안 들어감
      const stage = this.age < this.crunchAt ? TUNING.firmStage : 1;
      const goal = TUNING.depth * stage * (1 + TUNING.holdExtra * hold * hold);
      const k = TUNING.stiffness;
      const c = 2 * Math.sqrt(k) * TUNING.damping;
      // 단단한 스프링은 큰 dt에서 발산하므로 1/240초 단위로 쪼개서 적분 (저사양 폰 30fps 대비)
      const steps = Math.ceil(dt / (1 / 240));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        this.vel += (k * (goal - this.depth) - c * this.vel) * h;
        this.depth += this.vel * h;
      }
    } else {
      const t = this.age - this.releasedAt - TUNING.releaseDelay;
      if (t > 0) {
        const s = THREE.MathUtils.smoothstep(t, 0, TUNING.recoverRamp);
        const rate = THREE.MathUtils.lerp(TUNING.recoverSlow, TUNING.recoverFast, s);
        this.depth *= Math.exp(-rate * dt);
        // 차오르면서 자국이 살짝 넓고 얕게 퍼짐
        this.radius += (TUNING.radius * 1.35 - this.radius) * ease(2, dt);
      }
    }
    return this.held || this.depth > TUNING.depth * 0.01;
  }

  release() {
    this.held = false;
    this.releasedAt = this.age;
    this.vel = 0;
  }
}

type PointerState =
  | { mode: 'press'; dent: Dent; last: THREE.Vector3 }
  | { mode: 'tilt'; x: number; y: number };

/** GLB를 미터 단위 float 지오메트리로 굽는다 (meshopt 양자화 노드 스케일 제거) */
function bakeMesh(mesh: THREE.Mesh) {
  mesh.updateWorldMatrix(true, false);
  const m = mesh.matrixWorld.clone();
  const normalMat = new THREE.Matrix3().getNormalMatrix(m);
  const linear = new THREE.Matrix3().setFromMatrix4(m);
  const src = mesh.geometry;

  const toFloat = (attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => {
    const s = attr.itemSize;
    const arr = new Float32Array(attr.count * s);
    for (let i = 0; i < attr.count; i++) {
      arr[i * s] = attr.getX(i);
      if (s > 1) arr[i * s + 1] = attr.getY(i);
      if (s > 2) arr[i * s + 2] = attr.getZ(i);
      if (s > 3) arr[i * s + 3] = attr.getW(i);
    }
    return new THREE.BufferAttribute(arr, s);
  };

  const g = new THREE.BufferGeometry();
  g.setIndex(src.index);
  const pos = toFloat(src.attributes.position);
  pos.applyMatrix4(m);
  g.setAttribute('position', pos);
  const nrm = toFloat(src.attributes.normal);
  nrm.applyNormalMatrix(normalMat);
  g.setAttribute('normal', nrm);
  if (src.attributes.uv) g.setAttribute('uv', toFloat(src.attributes.uv));

  g.morphTargetsRelative = src.morphTargetsRelative;
  if (src.morphAttributes.position) {
    g.morphAttributes.position = src.morphAttributes.position.map((a) => {
      const f = toFloat(a);
      if (src.morphTargetsRelative) f.applyMatrix3(linear);
      else f.applyMatrix4(m);
      return f;
    });
  }
  if (src.morphAttributes.normal) {
    g.morphAttributes.normal = src.morphAttributes.normal.map((a) => {
      const f = toFloat(a);
      f.applyMatrix3(normalMat);
      return f;
    });
  }
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

export class SoapEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.01, 10);
  private soapGroup = new THREE.Group();
  private soap: THREE.Mesh | null = null;
  private proxy: THREE.Mesh | null = null;
  private material: THREE.MeshPhysicalMaterial | null = null;
  private shadow: THREE.Mesh;
  private uniforms = createDentUniforms();
  private dents: Dent[] = [];
  private pointers = new Map<number, PointerState>();
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private tilt = { x: 0, y: 0, vx: 0, vy: 0 };
  private morph = { squeeze: 0, pullL: 0, pullR: 0 };
  private morphIndex: Record<string, number> = {};
  private audio = new CrunchAudio();
  private haptics = true;
  private raf = 0;
  private last = 0;
  private dirty = true;
  private disposed = false;
  private resizeObserver: ResizeObserver;
  private size = { w: 1, h: 1 };
  private tintTarget = new THREE.Color(SOAP_TINTS.ivory);
  private baseColor: THREE.Color | null = null;
  private reducedMotion = false;
  private sway = 1; // 가만히 있을 때 살짝 흔들리는 정도 (만지면 0으로)
  private time = 0;

  constructor(private canvas: HTMLCanvasElement, private events: EngineEvents = {}) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    // 바닥에 떨어지는 부드러운 실제 그림자 — 비누가 '놓여 있는' 느낌의 핵심
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;

    // 약한 환경광 + 옆에서 부드러운 키 라이트 (정면 강한 빛은 비누를 흰 덩어리로 만듦)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;
    pmrem.dispose();

    // 낮은 각도의 옆빛이어야 윗면 곡률·눌린 자국·각인이 드러난다
    const key = new THREE.DirectionalLight('#fff1dc', 3.0);
    key.position.set(-0.5, 0.3, 0.12);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.radius = 12;
    key.shadow.blurSamples = 16;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.0006;
    const sc = key.shadow.camera as THREE.OrthographicCamera;
    sc.left = -0.16;
    sc.right = 0.16;
    sc.top = 0.16;
    sc.bottom = -0.16;
    sc.near = 0.2;
    sc.far = 0.9;
    this.scene.add(key);
    // 아랫면은 어둡게, 윗면은 밝게 — 두께감
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#a39b8e', 0.35));
    const fill = new THREE.DirectionalLight('#e3f6ff', 0.45);
    fill.position.set(0.7, 0.35, 0.4);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight('#ffffff', 0.5);
    rim.position.set(0.1, 0.3, -0.8);
    this.scene.add(rim);

    this.shadow = this.makeShadow();
    this.scene.add(this.shadow);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6), new THREE.ShadowMaterial({ opacity: 0.16 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.0145;
    floor.receiveShadow = true;
    this.scene.add(floor);

    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.audio.bindGestures();
    this.scene.add(this.soapGroup);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('lostpointercapture', this.onUp);
    canvas.addEventListener('contextmenu', this.prevent);
    canvas.addEventListener('keydown', this.onKeyDown);
    canvas.addEventListener('keyup', this.onKeyUp);
    canvas.addEventListener('webglcontextlost', this.onContextLost);

    // ?debug 로 열면 콘솔에서 __soap.debugState() 로 상태 확인
    if (new URLSearchParams(location.search).has('debug')) (window as unknown as { __soap: SoapEngine }).__soap = this;

    this.load();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ---------- 공개 API ----------
  setSound(on: boolean) {
    this.audio.setEnabled(on);
  }

  setHaptics(on: boolean) {
    this.haptics = on;
  }

  /** 0~1 */
  setVolume(v: number) {
    this.audio.setVolume(v);
  }

  setTint(tint: SoapTint) {
    // 비누 색 ↔ 녹음 속 같은 색 물체의 소리 (아이보리는 전체에서)
    this.audio.setGroup(TINT_SOUND_GROUP[tint]);
    // 아이보리는 Blender 원본 재질 색을 그대로 쓴다
    if (tint === 'ivory' && this.baseColor) this.tintTarget.copy(this.baseColor);
    else this.tintTarget.set(SOAP_TINTS[tint]);
    this.dirty = true;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onDown);
    c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointercancel', this.onUp);
    c.removeEventListener('lostpointercapture', this.onUp);
    c.removeEventListener('contextmenu', this.prevent);
    c.removeEventListener('keydown', this.onKeyDown);
    c.removeEventListener('keyup', this.onKeyUp);
    c.removeEventListener('webglcontextlost', this.onContextLost);
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((mm) => mm.dispose());
      }
    });
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.audio.dispose();
  }

  // ---------- 로드 ----------
  private load() {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load(
      '/models/slang_soap.glb',
      (gltf) => {
        if (this.disposed) return;
        let found: THREE.Mesh | null = null;
        gltf.scene.traverse((o) => {
          if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
        });
        if (!found) {
          this.events.onError?.('비누 모델을 찾지 못했어요');
          return;
        }
        const src: THREE.Mesh = found;
        const geometry = bakeMesh(src);
        const material = createSoapMaterial(src.material as THREE.MeshStandardMaterial, this.uniforms);
        this.loadStamp(material);
        this.baseColor = material.color.clone();
        if (this.tintTarget.equals(new THREE.Color(SOAP_TINTS.ivory))) this.tintTarget.copy(this.baseColor);
        this.material = material;

        const soap = new THREE.Mesh(geometry, material);
        soap.frustumCulled = false;
        soap.castShadow = true;
        soap.morphTargetDictionary = { ...(src.morphTargetDictionary ?? {}) };
        soap.morphTargetInfluences = (src.morphTargetInfluences ?? []).map(() => 0);
        this.morphIndex = soap.morphTargetDictionary;
        this.soap = soap;
        this.soapGroup.add(soap);

        // 레이캐스트용: 모프 없는 같은 지오메트리 (CPU 모프 계산 피함)
        const pg = new THREE.BufferGeometry();
        pg.setIndex(geometry.index);
        pg.setAttribute('position', geometry.attributes.position);
        pg.setAttribute('normal', geometry.attributes.normal);
        pg.computeBoundingSphere();
        pg.computeBoundingBox();
        this.proxy = new THREE.Mesh(pg, new THREE.MeshBasicMaterial());
        this.proxy.visible = false;
        this.soapGroup.add(this.proxy);

        src.geometry.dispose();
        (src.material as THREE.Material).dispose();

        // 첫 프레임에서 셰이더 컴파일 끊김 방지
        this.renderer.compile(this.scene, this.camera);
        this.dirty = true;
        this.events.onReady?.();
        // 화면이 뜬 뒤에 녹음 효과음을 받는다 (첫 화면 로딩을 늦추지 않게)
        void this.audio.preload();
      },
      (e) => {
        if (e.total) this.events.onProgress?.(e.loaded / e.total);
      },
      () => this.events.onError?.('비누를 불러오지 못했어요. 네트워크를 확인하고 새로고침해 주세요.'),
    );
  }

  /**
   * 각인 텍스처 교체. 원본 GLB 각인은 글자 테두리 1~2px 선뿐이라 휴대폰 크기에서 사라진다.
   * scripts/make-stamp.py 로 구운 넓은 경사 노멀맵 + 홈 그늘 마스크로 바꾼다. (실패하면 원본 유지)
   */
  private loadStamp(material: THREE.MeshPhysicalMaterial) {
    const loader = new THREE.TextureLoader();
    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const prep = (t: THREE.Texture) => {
      t.flipY = false; // glTF와 같은 UV 방향
      t.colorSpace = THREE.NoColorSpace;
      t.anisotropy = aniso; // 비스듬히 보는 윗면에서도 또렷하게
      return t;
    };
    Promise.all([
      loader.loadAsync('/models/soap_stamp_normal.png'),
      loader.loadAsync('/models/soap_stamp_cavity.png'),
    ])
      .then(([normal, cavity]) => {
        if (this.disposed) return;
        material.normalMap?.dispose();
        material.normalMap = prep(normal);
        const sy = Math.sign(material.normalScale.y) || 1;
        material.normalScale.set(1, sy);
        stampUniforms.uStampCavity.value = prep(cavity);
        stampUniforms.uCavityStrength.value = 0.2;
        this.dirty = true;
      })
      .catch(() => {
        /* 원본 각인으로 계속 */
      });
  }

  private makeShadow() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grd.addColorStop(0, 'rgba(25,31,40,0.42)');
    grd.addColorStop(0.5, 'rgba(25,31,40,0.16)');
    grd.addColorStop(1, 'rgba(25,31,40,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.104 * 1.2, 0.066 * 1.3),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = -0.0143;
    return mesh;
  }

  // ---------- 화면 크기 ----------
  private resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    if (w === this.size.w && h === this.size.h) return;
    this.size = { w, h };
    this.renderer.setSize(w, h, false);
    const cam = this.camera;
    cam.aspect = w / h;
    const tan = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    // 세로 화면 기준: 비누 가로가 화면 폭의 ~78%를 채우도록
    const dW = (0.104 / 0.78) / (2 * tan * cam.aspect);
    const dH = (0.066 * 2.1) / (2 * tan);
    const dist = Math.max(dW, dH);
    // 너무 위에서 내려다보면 납작해 보임 — 옆면 두께가 보이도록 약 45°
    const dir = new THREE.Vector3(0, 0.72, 0.7).normalize();
    cam.position.copy(dir.multiplyScalar(dist));
    // 윗면 가운데가 화면 정중앙에 오도록 (첫 안내 링 위치와 일치)
    cam.lookAt(0, 0.012, 0);
    cam.updateProjectionMatrix();
    this.dirty = true;
  }

  // ---------- 입력 ----------
  private prevent = (e: Event) => e.preventDefault();

  private hit(clientX: number, clientY: number) {
    if (!this.proxy) return null;
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const h = this.raycaster.intersectObject(this.proxy, false)[0];
    if (!h) return null;
    const local = this.soapGroup.worldToLocal(h.point.clone());
    const normal = (h.normal ?? h.face?.normal ?? new THREE.Vector3(0, 1, 0)).clone().normalize();
    return { local, normal };
  }

  private panOf(clientX: number) {
    const rect = this.canvas.getBoundingClientRect();
    return THREE.MathUtils.clamp(((clientX - rect.left) / rect.width) * 2 - 1, -1, 1) * 0.6;
  }

  private startDent(id: number, local: THREE.Vector3, normal: THREE.Vector3, pan: number, intensity: number) {
    this.audio.unlock();
    const dent = new Dent(id, local, normal, pan);
    this.dents.push(dent);
    while (this.dents.length > MAX_DENTS) this.dents.shift();
    this.pointers.set(id, { mode: 'press', dent, last: local.clone() });
    // 소리는 닿는 즉시 낸다. 50ms만 늦어도 손과 귀가 어긋나게 느껴진다.
    // 비누가 꺼지는 순간은 그 소리의 첫 '바삭'에 맞춘다.
    dent.crunchAt = this.audio.press(intensity, pan);
    if (this.haptics) navigator.vibrate?.([12, 16, 8, 20, 5]);
    this.events.onPress?.();
    this.dirty = true;
    return dent;
  }

  private onDown = (e: PointerEvent) => {
    e.preventDefault();
    this.audio.unlock();
    this.canvas.setPointerCapture?.(e.pointerId);
    const h = this.hit(e.clientX, e.clientY);
    if (h) {
      // 터치 화면의 pressure는 힘이 아님 — 펜일 때만 보조 입력으로 사용
      const intensity = e.pointerType === 'pen' && e.pressure > 0 ? 0.45 + e.pressure * 0.6 : 0.85 + Math.random() * 0.15;
      this.startDent(e.pointerId, h.local, h.normal, this.panOf(e.clientX), intensity);
    } else {
      this.pointers.set(e.pointerId, { mode: 'tilt', x: e.clientX, y: e.clientY });
    }
  };

  private onMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    if (p.mode === 'tilt') {
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      this.tilt.vy += dx * 0.004;
      this.tilt.vx += dy * 0.003;
      this.dirty = true;
      return;
    }
    const h = this.hit(e.clientX, e.clientY);
    if (!h) return;
    p.dent.target.copy(h.local);
    p.dent.targetNormal.copy(h.normal);
    p.dent.pan = this.panOf(e.clientX);
    const moved = h.local.distanceTo(p.last);
    p.last.copy(h.local);
    // 5mm 이동 ≈ 최대 사각거림
    this.audio.scrub(moved / 0.005, p.dent.pan);
  };

  private onUp = (e: PointerEvent) => {
    // 터치에서는 손을 뗄 때가 오디오를 켤 수 있는 순간
    if (e.type === 'pointerup') this.audio.unlock();
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    if (p.mode === 'press') {
      this.audio.release(p.dent.depth / TUNING.depth);
      p.dent.release();
    }
  };

  private keyHeld = false;
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (this.keyHeld || !this.soap) return;
    this.keyHeld = true;
    const top = this.soap.geometry.boundingBox!.max.y;
    this.startDent(-1, new THREE.Vector3(0, top, 0), new THREE.Vector3(0, 1, 0), 0, 0.9);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    this.keyHeld = false;
    this.onUp({ pointerId: -1 } as PointerEvent);
  };

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.events.onError?.('화면을 다시 그릴 수 없어요. 새로고침해 주세요.');
  };

  // ---------- 루프 ----------
  private frame = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    // 느린 폰에서도 실제 시간대로 움직이게 0.1초까지 허용 (스프링은 내부에서 잘게 나눠 계산)
    const dt = Math.min((now - (this.last || now)) / 1000, 0.1);
    this.last = now;
    if (!this.soap) {
      if (this.dirty) this.render();
      this.dirty = false;
      return;
    }
    this.time += dt;

    let active = this.dirty;

    // 눌림
    for (let i = this.dents.length - 1; i >= 0; i--) {
      const d = this.dents[i];
      if (!d.update(dt)) this.dents.splice(i, 1);
      else this.soundFromDent(d, dt);
    }
    this.syncDents();
    if (this.dents.length) active = true;

    // 모프: 두 손가락 이상 → Squeeze, 누른 채 좌우로 끌기 → Pull
    const held = this.dents.filter((d) => d.held);
    let pull = 0;
    for (const d of held) pull += d.center.x - d.start.x;
    const targets = {
      squeeze: held.length >= 2 ? 0.75 : 0,
      pullL: THREE.MathUtils.clamp(-pull / 0.03, 0, 1) * 0.7,
      pullR: THREE.MathUtils.clamp(pull / 0.03, 0, 1) * 0.7,
    };
    for (const k of ['squeeze', 'pullL', 'pullR'] as const) {
      const rising = targets[k] > this.morph[k];
      this.morph[k] += (targets[k] - this.morph[k]) * ease(rising ? 9 : 3.2, dt);
      if (Math.abs(this.morph[k] - targets[k]) > 1e-4) active = true;
    }
    this.applyMorph('Squeeze', this.morph.squeeze);
    this.applyMorph('Pull_Left', this.morph.pullL);
    this.applyMorph('Pull_Right', this.morph.pullR);

    // 기울이기: 손 떼면 제자리로 스프링 복귀
    const tilting = [...this.pointers.values()].some((p) => p.mode === 'tilt');
    const t = this.tilt;
    t.x = THREE.MathUtils.clamp(t.x + t.vx, -TUNING.tiltMax, TUNING.tiltMax);
    t.y = THREE.MathUtils.clamp(t.y + t.vy, -TUNING.tiltMax * 1.5, TUNING.tiltMax * 1.5);
    t.vx = 0;
    t.vy = 0;
    if (!tilting) {
      t.x *= 1 - ease(4, dt);
      t.y *= 1 - ease(4, dt);
    }
    if (Math.abs(t.x) + Math.abs(t.y) > 1e-4) active = true;

    // 가만히 있을 땐 아주 천천히 흔들려 입체감을 보여주고, 만지는 동안엔 멈춤
    const touching = this.pointers.size > 0 || this.dents.length > 0;
    this.sway += ((touching || this.reducedMotion ? 0 : 1) - this.sway) * ease(touching ? 6 : 0.8, dt);
    const sx = Math.sin(this.time * 0.55) * 0.045 * this.sway;
    const sy = Math.sin(this.time * 0.37 + 1.3) * 0.11 * this.sway;
    if (this.sway > 1e-3) active = true;
    this.soapGroup.rotation.set(t.x + sx, t.y + sy, 0);

    // 색 전환
    if (this.material && !this.material.color.equals(this.tintTarget)) {
      const c = this.material.color;
      c.lerp(this.tintTarget, ease(10, dt));
      if (Math.abs(c.r - this.tintTarget.r) + Math.abs(c.g - this.tintTarget.g) + Math.abs(c.b - this.tintTarget.b) < 1e-3) {
        c.copy(this.tintTarget);
      }
      active = true;
    }

    // 눌릴수록 그림자 진해짐
    const press = this.dents.reduce((s, d) => s + d.depth, 0) / TUNING.depth;
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.9 + Math.min(press, 1.5) * 0.1;

    if (active) this.render();
    this.dirty = false;
  };

  /**
   * 비누가 실제로 변형된 만큼 소리를 낸다. (녹음 알갱이)
   *  - 눌려 들어간 깊이만큼 '바삭' — 빨리 누를수록 크고 촘촘하게, 멈추면 조용
   *  - 누른 채 문지른 거리만큼 '사각'
   *  - 다시 부풀어 오르는 만큼 희미하게
   */
  private soundFromDent(d: Dent, dt: number) {
    const dDepth = (d.depth - d.prevDepth) / TUNING.depth; // 이번 프레임 깊이 변화 (최대 깊이 = 1)
    const moved = d.held ? d.center.distanceTo(d.prevCenter) : 0; // m
    d.prevDepth = d.depth;
    d.prevCenter.copy(d.center);
    if (dt <= 0) return;

    if (dDepth > 0 && d.held) {
      // 끝까지 한 번 누르면 약 30알
      d.grainAcc += dDepth * 30;
      this.emitGrains(d, 'press', THREE.MathUtils.clamp(dDepth / dt / 10, 0.3, 1), dt);
    } else if (dDepth < 0 && !d.held) {
      // 다시 부풀 때 약 8알, 아주 작게
      d.grainAcc += -dDepth * 8;
      this.emitGrains(d, 'release', THREE.MathUtils.clamp(-dDepth / dt / 3, 0.15, 0.4), dt);
    }
    if (moved > 0) {
      // 1mm 문지를 때마다 약 1알, 빠를수록 크게
      d.grainAcc += (moved / 0.001) * 1.0;
      this.emitGrains(d, 'move', THREE.MathUtils.clamp(moved / dt / 0.08, 0.2, 0.85), dt);
    }
  }

  private emitGrains(d: Dent, kind: GrainKind, loud: number, dt: number) {
    const n = Math.min(10, Math.floor(d.grainAcc));
    if (n <= 0) return;
    d.grainAcc -= n;
    this.audio.grains(kind, n, loud, d.pan, Math.min(dt, 0.05));
  }

  private applyMorph(name: string, w: number) {
    const i = this.morphIndex[name];
    if (i !== undefined && this.soap?.morphTargetInfluences) this.soap.morphTargetInfluences[i] = w < 1e-4 ? 0 : w;
  }

  private syncDents() {
    const n = Math.min(this.dents.length, MAX_DENTS);
    const list = this.dents.slice(-n);
    for (let i = 0; i < n; i++) {
      const d = list[i];
      this.uniforms.uDentC.value[i].set(d.center.x, d.center.y, d.center.z, Math.max(0, d.depth));
      this.uniforms.uDentN.value[i].set(d.normal.x, d.normal.y, d.normal.z, d.radius);
    }
    this.uniforms.uDentCount.value = n;
  }

  private render() {
    this.renderer.render(this.scene, this.camera);
  }

  /** 테스트/디버그용 상태 */
  debugState() {
    return {
      dents: this.dents.map((d) => ({ depth: d.depth, held: d.held })),
      morph: { ...this.morph },
      loaded: !!this.soap,
    };
  }
}
