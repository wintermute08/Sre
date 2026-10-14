// 크런치 사운드 합성 엔진 — 샘플 파일 없이 Web Audio로 매번 조금씩 다르게 만든다.
// 목표는 'ASMR처럼 계속 듣기 좋은' 사각거림:
//  - 쨍한 화이트 노이즈 대신 부드러운 핑크 노이즈
//  - 크게 튀는 '딱' 없이, 작고 고른 알갱이를 촘촘하게 (피크/평균 차이를 줄임)
//  - 귀가 예민한 2~5kHz는 덜고, 따뜻한 중음역(450~3200Hz) 위주
//  - 아주 짧은 잔향으로 귀 가까이에서 나는 소리처럼
// 알갱이는 시작할 때 미리 구워 두고(BufferSource 1개 + Gain + Panner) 재사용해 휴대폰 부담을 줄인다.
// 음량은 항상 실제 변형량(깊이, 이동량, 복원 속도)에 연결한다.

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(arr: T[]) => arr[(Math.random() * arr.length) | 0];
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

type AudioCtor = typeof AudioContext;

/** 핑크 노이즈 (Paul Kellet) */
function pinkNoise(n: number) {
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

/** RBJ 밴드패스 (JS에서 미리 굽기용) */
function bandpass(x: Float32Array, sr: number, f: number, q: number) {
  const w = (2 * Math.PI * f) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0, b2 = -alpha / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** 짧은 알갱이 하나를 굽는다: 둥근 시작 + 지수 감쇠, 피크 1로 정규화 */
function bakeGrain(ctx: BaseAudioContext, f: number, q: number, attack: number, tau: number) {
  const sr = ctx.sampleRate;
  const len = Math.ceil(sr * (attack + tau * 6));
  const src = pinkNoise(len + 256);
  const y = bandpass(src, sr, f, q).subarray(256);
  let peak = 1e-6;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const env = t < attack ? Math.sin((t / attack) * Math.PI * 0.5) ** 2 : Math.exp(-(t - attack) / tau);
    y[i] *= env;
    peak = Math.max(peak, Math.abs(y[i]));
  }
  const buf = ctx.createBuffer(1, len, sr);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = y[i] / peak;
  return buf;
}

export class CrunchAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private crackles: AudioBuffer[] = []; // 사각거림 알갱이
  private bodies: AudioBuffer[] = []; // 낮고 둥근 '톡'
  private airs: AudioBuffer[] = []; // 버티는 동안의 미세한 소리
  private master: GainNode | null = null;
  private bus: AudioNode | null = null;
  private lastScrub = 0;
  private enabled = true;
  private volume = 0.85;

  private pending: { intensity: number; pan: number; at: number } | null = null;
  private gestureBound = false;

  /**
   * 오디오 준비. 아무 때나 불러도 되지만 실제로 켜지는 건 '사용자 활성화' 제스처 안에서뿐이다.
   * 주의: 터치에서는 pointerdown이 활성화 제스처가 아니다(pointerup / touchend / click만 해당).
   * 그래서 첫 터치의 pointerdown에서는 꺼져 있을 수 있고, 손을 떼는 순간 켜진다.
   */
  unlock(): boolean {
    if (!this.ctx && !this.create()) return false;
    const ctx = this.ctx!;
    if (ctx.state !== 'running') {
      // iOS 구버전: 제스처 안에서 무음 버퍼를 한 번 재생해야 풀린다
      try {
        const b = ctx.createBufferSource();
        b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        b.connect(ctx.destination);
        b.start(0);
      } catch {
        /* 무시 */
      }
      ctx.resume().catch(() => {});
    }
    return true;
  }

  /** 페이지 어디를 탭해도 오디오가 켜지도록 활성화 제스처에 연결 */
  bindGestures() {
    if (this.gestureBound) return;
    this.gestureBound = true;
    const opts = { capture: true, passive: true } as const;
    for (const type of ['pointerup', 'touchend', 'click', 'keydown'] as const) {
      window.addEventListener(type, this.onGesture, opts);
    }
    document.addEventListener('visibilitychange', this.onGesture);
  }

  private onGesture = () => {
    if (document.visibilityState === 'hidden') return;
    if (!this.ctx || this.ctx.state !== 'running') this.unlock();
  };

  private create(): boolean {
    const AC: AudioCtor | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
    if (!AC) return false;
    let ctx: AudioContext;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch {
      ctx = new AC();
    }
    this.ctx = ctx;

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    this.noise.getChannelData(0).set(pinkNoise(len));

    // 알갱이 미리 굽기 (약 30ms 분량 × 50개, 시작 시 한 번)
    for (let i = 0; i < 36; i++) {
      const f = Math.exp(rand(Math.log(450), Math.log(3200)));
      this.crackles.push(bakeGrain(ctx, f, rand(0.7, 1.3), rand(0.0015, 0.003), rand(0.003, 0.009)));
    }
    for (let i = 0; i < 8; i++) {
      this.bodies.push(bakeGrain(ctx, rand(180, 480), rand(0.6, 1), rand(0.003, 0.006), rand(0.012, 0.025)));
    }
    for (let i = 0; i < 8; i++) {
      this.airs.push(bakeGrain(ctx, rand(700, 1800), rand(1, 1.6), rand(0.002, 0.004), rand(0.002, 0.004)));
    }

    // 최종단: 고르게 눌러주는 컴프레서 (튀는 소리 정리)
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    this.master.connect(comp).connect(ctx.destination);

    // 톤: 귀가 예민한 대역(2.5kHz 이상)은 덜고, 4.5kHz 위는 걷어낸다
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 2500;
    shelf.gain.value = -6;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4500;
    lp.Q.value = 0.5;
    shelf.connect(lp);
    lp.connect(this.master);

    // 아주 짧은 잔향: 귀 가까이에서 나는 듯한 따뜻함
    const verb = ctx.createConvolver();
    verb.buffer = this.makeRoom(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.22;
    lp.connect(verb).connect(wet).connect(this.master);
    this.bus = shelf;

    // 켜지기 전에 누른 첫 크런치는 켜지는 순간 들려준다
    ctx.addEventListener('statechange', () => {
      if (ctx.state !== 'running' || !this.pending) return;
      const p = this.pending;
      this.pending = null;
      // 꾹 누르고 있다가 떼는 경우도 있으니 넉넉히 기다린다
      if (performance.now() - p.at < 4000) this.press(p.intensity * 0.8, p.pan);
    });
    return true;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(on ? this.volume : 0, this.ctx.currentTime, 0.02);
    }
  }

  private get ready() {
    return this.enabled && this.ctx !== null && this.ctx.state === 'running';
  }

  private makeRoom(ctx: BaseAudioContext) {
    const sr = ctx.sampleRate;
    const len = Math.ceil(sr * 0.12);
    const ir = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        lp += 0.25 * ((Math.random() * 2 - 1) - lp); // 어둡게
        d[i] = lp * Math.exp(-i / (sr * 0.022));
      }
    }
    return ir;
  }

  /** 미리 구운 알갱이 재생 */
  private play(buf: AudioBuffer, t: number, gain: number, pan = 0, rate = 1) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(g).connect(p).connect(this.bus!);
    src.start(t);
  }

  /** 낮게 '퍽' — 몸체가 눌리는 느낌 */
  private thump(t: number, gain: number, from = 600, to = 180, dur = 0.12) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(from, t);
    lp.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(g).connect(this.master!);
    src.start(t, rand(0, 1.5), dur + 0.02);
  }

  /** 누르는 순간의 메인 크런치. intensity 0~1. 지연 없이 바로 낸다. */
  press(intensity: number, pan = 0) {
    if (!this.enabled) return;
    if (!this.ready) {
      this.pending = { intensity, pan, at: performance.now() };
      return;
    }
    const now = this.ctx!.currentTime + 0.004;
    const k = Math.max(0.25, clamp01(intensity));

    const t0 = now;
    this.thump(t0, 0.32 * k);

    // 메인: 작고 고른 알갱이를 촘촘하게 (크게 튀는 알갱이 없음)
    // '치직' 잡음처럼 들리지 않게 알갱이는 적게, 하나하나는 또렷하게
    const span = rand(0.16, 0.22) + 0.04 * k;
    const n = Math.round(rand(50, 65) + 20 * k);
    for (let i = 0; i < n; i++) {
      const u = Math.pow(Math.random(), 1.5); // 앞쪽에 살짝 몰리게
      const fade = 1 - 0.6 * u; // 뒤로 갈수록 작아짐
      this.play(pick(this.crackles), t0 + span * u, rand(0.09, 0.15) * fade * k, pan + rand(-0.45, 0.45), rand(0.85, 1.15));
    }
    // 둥근 '톡'이 몇 개 섞이면 바삭함에 무게가 생김
    const bodies = Math.round(rand(5, 7));
    for (let i = 0; i < bodies; i++) {
      this.play(pick(this.bodies), t0 + span * 0.6 * Math.random(), rand(0.14, 0.22) * k, pan + rand(-0.2, 0.2), rand(0.9, 1.1));
    }
    // 꾹 누르고 있는 동안 몇 번만 '사각' (ASMR 꼬리, 잡음처럼 깔리지 않게)
    const tail = Math.round(rand(4, 7));
    for (let i = 0; i < tail; i++) {
      const u = Math.pow(Math.random(), 1.8);
      this.play(pick(this.crackles), t0 + span + 0.5 * u, rand(0.03, 0.05) * (1 - 0.6 * u) * k, pan + rand(-0.5, 0.5), rand(0.85, 1.1));
    }
  }

  /** 누른 채로 문지를 때. amount = 이번 프레임 이동량(0~1 정규화) */
  scrub(amount: number, pan = 0) {
    if (!this.ready || amount <= 0.02) return;
    const now = this.ctx!.currentTime;
    if (now - this.lastScrub < 0.06) return;
    this.lastScrub = now;
    const k = clamp01(amount);
    const n = Math.max(1, Math.round(k * 7));
    for (let i = 0; i < n; i++) {
      this.play(pick(this.crackles), now + rand(0, 0.05), rand(0.04, 0.08) * (0.4 + 0.6 * k), pan + rand(-0.35, 0.35), rand(0.85, 1.15));
    }
  }

  /** 손을 뗄 때 공기가 빨려 들어가는 '스윽' */
  release(depth: number) {
    if (!this.ready) return;
    const k = clamp01(depth);
    if (k < 0.05) return;
    const now = this.ctx!.currentTime;
    this.thump(now + 0.01, 0.05 * k, 220, 700, 0.3);
    // 다시 부풀면서 아주 가끔 '사각' — 프레임과 무관하게 미리 정해 둠 (폰 성능과 상관없이 같은 소리)
    const n = Math.round(rand(3, 5) * k);
    for (let i = 0; i < n; i++) {
      this.play(pick(this.crackles), now + 0.2 + 1.0 * Math.pow(Math.random(), 1.4), rand(0.02, 0.04) * k, rand(-0.5, 0.5), rand(0.9, 1.1));
    }
  }

  dispose() {
    for (const type of ['pointerup', 'touchend', 'click', 'keydown'] as const) {
      window.removeEventListener(type, this.onGesture, true);
    }
    document.removeEventListener('visibilitychange', this.onGesture);
    this.gestureBound = false;
    this.pending = null;
    void this.ctx?.close();
    this.ctx = null;
  }
}
