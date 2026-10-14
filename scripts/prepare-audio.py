"""직접 녹음한 슬랑이 효과음 팩 → 웹용 파일.

입력: slangi-audio-pack 폴더 (web/*.wav + manifest.json)
출력: public/audio/<id>.wav (모노 16bit, 내용 그대로) + public/audio/clips.json

- 녹음이 좌우 완전히 같아서 모노로 합친다 (손실 없음, 용량 절반).
  MP3/AAC는 앞에 무음 패딩이 생겨 지연이 늘어서 WAV 유지.
- 파일 자체의 볼륨·음높이·속도·EQ는 바꾸지 않는다. 대신 재생에 필요한 값을 clips.json에 기록:
    onset  : 파일 앞 무음 뒤 실제 소리가 시작되는 시각(초) → 여기서부터 재생해 지연 제거
    peak   : onset 뒤 첫 '강한' 바삭(최대의 60% 이상)까지(초) → 화면에서 비누가 꺼지는 순간과 맞춤
    gain   : 클립 간 크기를 전체 중앙값에 맞추는 재생 배율 (+6dB ~ -9dB)
    grains : 녹음 속 '바삭' 알갱이 하나하나의 위치(초)와 세기(dBFS).
             앱은 클립을 통째로 틀지 않고, 비누가 변형되는 속도에 맞춰 이 알갱이들을 뿌린다.

사용: python3 scripts/prepare-audio.py <slangi-audio-pack 폴더>
"""

import json
import sys
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "audio"
MAX_BOOST_DB = 6.0  # 조용한 클립을 너무 키우면 녹음 잡음도 커짐
MAX_CUT_DB = 9.0


def read(path: Path):
    with wave.open(str(path)) as w:
        sr, ch = w.getframerate(), w.getnchannels()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).reshape(-1, ch)
    return sr, x


def find_grains(f: np.ndarray, sr: int):
    """1ms 단위 에너지에서 주변보다 확 튀는 순간(바삭)을 찾는다."""
    hop = int(sr * 0.001)
    n = len(f) // hop
    env = np.sqrt((f[: n * hop].reshape(n, hop) ** 2).mean(1)) + 1e-9
    med = np.array([np.median(env[max(0, i - 25) : i + 25]) for i in range(n)])
    floor = 10 ** (-40 / 20)  # 녹음 잡음보다 충분히 큰 것만
    peaks = []
    for i in range(1, n - 1):
        lo, hi = max(0, i - 6), min(n, i + 7)
        if env[i] == env[lo:hi].max() and env[i] > 2.2 * med[i] and env[i] > floor:
            if not peaks or i - peaks[-1] >= 8:
                peaks.append(i)
    # 어택이 잘리지 않게 2ms 앞에서 시작
    return [[round(max(0, i - 2) / 1000, 4), round(float(20 * np.log10(env[i])), 1)] for i in peaks]


def main(pack: Path):
    manifest = json.loads((pack / "manifest.json").read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    clips = []
    rms_db = {}
    for c in manifest["clips"]:
        sr, x = read(pack / c["file"])
        if x.shape[1] == 2 and not np.array_equal(x[:, 0], x[:, 1]):
            mono = ((x[:, 0].astype(np.int32) + x[:, 1]) // 2).astype(np.int16)
        else:
            mono = x[:, 0].copy()

        f = mono.astype(np.float64) / 32768
        env = np.abs(f)
        win = max(1, int(sr * 0.002))
        n = len(env) // win
        blocks = env[: n * win].reshape(n, win).max(1)
        onset_i = int(np.argmax(blocks > blocks.max() * 0.25)) * win
        onset_i = max(0, onset_i - int(sr * 0.004))  # 어택이 잘리지 않게 4ms 여유
        peak_i = onset_i + int(np.argmax(env[onset_i:] > env.max() * 0.6))

        w50 = int(sr * 0.05)
        rms = np.sqrt(np.convolve(f * f, np.ones(w50) / w50, mode="valid")).max()
        rms_db[c["id"]] = 20 * np.log10(rms + 1e-9)

        with wave.open(str(OUT / f"{c['id']}.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(mono.tobytes())

        clips.append(
            {
                "id": c["id"],
                "group": c["group"],
                "file": f"/audio/{c['id']}.wav",
                "onset": round(onset_i / sr, 4),
                "peak": round(max(0, peak_i - onset_i) / sr, 4),
                "duration": round(len(mono) / sr, 4),
                "grains": find_grains(f, sr),
            }
        )

    target = float(np.median(list(rms_db.values())))
    for c in clips:
        g = float(np.clip(target - rms_db[c["id"]], -MAX_CUT_DB, MAX_BOOST_DB))
        c["gain"] = round(10 ** (g / 20), 3)
        print(f"{c['id']:16s} onset {c['onset'] * 1000:5.0f}ms  첫 바삭 +{c['peak'] * 1000:4.0f}ms  gain {g:+5.1f}dB  알갱이 {len(c['grains'])}개")

    (OUT / "clips.json").write_text(json.dumps({"sampleRate": sr, "clips": clips}, ensure_ascii=False, separators=(",", ":")) + "\n")
    print("written", OUT)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
