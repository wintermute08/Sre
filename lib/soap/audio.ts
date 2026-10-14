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

  /** 사용자 제스처 안에서 호출해야 iOS/안드로이드에서 소리가 난다 */
  unlock(): boolean {
    if (!this.ctx) {
      const AC: AudioCtor | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
      if (!AC) return false;
      const ctx = new AC({ latencyHint: 'interactive' });
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
      shelf.frequency.value = 7000;
      shelf.gain.value = -5;
      shelf.connect(this.master);
      this.bus = shelf;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
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
    g.gain.linearRampToValueAtTime(gain, t + 0.0006);
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
    bp.frequency.value = rand(3500, 5500);
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
    if (!this.ready) return;
    const t0 = this.ctx!.currentTime + 0.004;
    const k = Math.max(0.25, clamp01(intensity));

    this.thump(t0, 0.45 * k);

    const span = rand(0.14, 0.2) + 0.08 * k; // 눌림 시간(0.12~0.2s)과 맞춤
    const n = Math.round(rand(45, 60) + 45 * k);
    for (let i = 0; i < n; i++) {
      const t = t0 + span * Math.pow(Math.random(), 1.9); // 앞쪽에 몰리게
      if (Math.random() < 0.1) {
        // 가끔 크게 '딱' 부서지는 알갱이
        this.grain(t, logRand(700, 1700), rand(1.2, 2.5), rand(0.01, 0.02), rand(0.5, 0.85) * k, pan + rand(-0.2, 0.2));
      } else {
        const gain = (0.12 + Math.pow(Math.random(), 3) * 0.6) * k;
        this.grain(t, logRand(1300, 9000), rand(0.9, 4), logRand(0.0018, 0.011), gain, pan + rand(-0.35, 0.35));
      }
    }
    this.fizz(t0, 0.07 * k, span * 1.1);
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
      this.grain(now + rand(0, 0.05), logRand(1500, 8500), rand(1, 3.5), logRand(0.0015, 0.008), rand(0.08, 0.32) * k, pan + rand(-0.3, 0.3));
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
      this.grain(now + rand(0, dt), logRand(2200, 8000), rand(1, 3), logRand(0.0012, 0.005), rand(0.03, 0.12) * clamp01(rate * 1.5), pan + rand(-0.4, 0.4));
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
    void this.ctx?.close();
    this.ctx = null;
  }
}
