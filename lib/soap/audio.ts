// 크런치 사운드 합성 엔진 — 샘플 파일 없이 Web Audio로 매번 조금씩 다르게 만든다.
// 원리: 1~12ms짜리 아주 짧은 노이즈 알갱이(grain)를 수십 개 앞쪽에 몰리게 뿌리면
// 압축된 알갱이가 부서지는 '사각사각 크런치'가 된다. 여기에 낮은 '퍽' 바디를 깐다.
// 음량은 항상 실제 변형량(깊이, 이동량, 복원 속도)에 연결한다.

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const logRand = (a: number, b: number) => Math.exp(rand(Math.log(a), Math.log(b)));
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

type AudioCtor = typeof AudioContext;

export class CrunchAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private master: GainNode | null = null;
  private bus: AudioNode | null = null;
  private lastScrub = 0;
  private enabled = true;
  private volume = 0.9;

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
    const ch = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;

    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 8;
    comp.ratio.value = 4;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    this.master.connect(comp).connect(ctx.destination);

    // 휴대폰 스피커에서 쨍하지 않게 고역을 살짝 깎는다
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 3500;
    shelf.gain.value = -8;
    // 6.5kHz 위 쇳소리 같은 성분은 걷어낸다
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 6500;
    lp.Q.value = 0.5;
    shelf.connect(lp).connect(this.master);
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

  private grain(t: number, freq: number, q: number, dur: number, gain: number, pan = 0) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.0015); // 너무 순간적이면 '틱' 하고 찌름
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(bp).connect(g).connect(p).connect(this.bus!);
    src.start(t, rand(0, 1.9), dur + 0.02);
  }

  private thump(t: number, gain: number, from = 900, to = 250, dur = 0.09) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.9;
    lp.frequency.setValueAtTime(from, t);
    lp.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp).connect(g).connect(this.master!);
    src.start(t, rand(0, 1.5), dur + 0.02);
  }

  private fizz(t: number, gain: number, dur: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = rand(2000, 3200);
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(this.bus!);
    src.start(t, rand(0, 1.4), dur + 0.02);
  }

  /** 누르는 순간의 메인 크런치. intensity 0~1 */
  press(intensity: number, pan = 0) {
    if (!this.enabled) return;
    if (!this.ready) {
      this.pending = { intensity, pan, at: performance.now() };
      return;
    }
    const t0 = this.ctx!.currentTime + 0.004;
    const k = Math.max(0.25, clamp01(intensity));

    this.thump(t0, 0.55 * k);

    const span = rand(0.14, 0.2) + 0.08 * k; // 눌림 시간(0.12~0.2s)과 맞춤
    const n = Math.round(rand(45, 60) + 45 * k);
    for (let i = 0; i < n; i++) {
      const t = t0 + span * Math.pow(Math.random(), 1.9); // 앞쪽에 몰리게
      if (Math.random() < 0.1) {
        // 가끔 크게 '딱' 부서지는 알갱이
        this.grain(t, logRand(500, 1300), rand(1.2, 2.5), rand(0.01, 0.02), rand(0.4, 0.7) * k, pan + rand(-0.2, 0.2));
      } else {
        const gain = (0.12 + Math.pow(Math.random(), 3) * 0.6) * k;
        this.grain(t, logRand(900, 5500), rand(0.9, 4), logRand(0.0018, 0.011), gain, pan + rand(-0.35, 0.35));
      }
    }
    this.fizz(t0, 0.045 * k, span * 1.1);
  }

  /** 누른 채로 문지를 때. amount = 이번 프레임 이동량(0~1 정규화) */
  scrub(amount: number, pan = 0) {
    if (!this.ready || amount <= 0.02) return;
    const now = this.ctx!.currentTime;
    if (now - this.lastScrub < 0.035) return;
    this.lastScrub = now;
    const k = clamp01(amount);
    const n = Math.max(1, Math.round(k * 14));
    for (let i = 0; i < n; i++) {
      this.grain(now + rand(0, 0.05), logRand(1000, 5000), rand(1, 3.5), logRand(0.0015, 0.008), rand(0.08, 0.32) * k, pan + rand(-0.3, 0.3));
    }
  }

  /** 꾹 누르고 있거나 복원 중일 때 프레임마다 호출. rate = 깊이 변화 속도(0~1 정규화) */
  settle(rate: number, dt: number, pan = 0) {
    if (!this.ready || rate <= 0.01) return;
    // 변화가 클수록 자주, 크게. 멈추면 소리도 멈춘다.
    const expected = rate * 40 * dt;
    let count = Math.floor(expected) + (Math.random() < expected % 1 ? 1 : 0);
    const now = this.ctx!.currentTime;
    while (count-- > 0) {
      this.grain(now + rand(0, dt), logRand(1500, 5000), rand(1, 3), logRand(0.0012, 0.005), rand(0.03, 0.12) * clamp01(rate * 1.5), pan + rand(-0.4, 0.4));
    }
  }

  /** 손을 뗄 때 공기가 빨려 들어가는 '스윽' */
  release(depth: number) {
    if (!this.ready) return;
    const k = clamp01(depth);
    if (k < 0.05) return;
    this.thump(this.ctx!.currentTime + 0.01, 0.07 * k, 300, 1100, 0.28);
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
