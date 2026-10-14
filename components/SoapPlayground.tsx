'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SoapEngine, SoapTint } from '@/lib/soap/engine';

const TINTS: { id: SoapTint; label: string; color: string }[] = [
  { id: 'ivory', label: '아이보리', color: '#e6e9de' },
  { id: 'peach', label: '피치', color: '#f6d5c4' },
  { id: 'pink', label: '핑크', color: '#f4c9d3' },
  { id: 'mint', label: '민트', color: '#cbe7da' },
  { id: 'lavender', label: '라벤더', color: '#dcd3f0' },
];

type Settings = { sound: boolean; haptics: boolean; tint: SoapTint };
const DEFAULT_SETTINGS: Settings = { sound: true, haptics: true, tint: 'ivory' };

// 브라우저 저장소는 막혀 있을 수 있으므로 항상 실패를 허용한다
function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 저장 못 해도 동작에는 문제 없음 */
  }
}
const today = () => new Date().toLocaleDateString('sv-SE');

export default function SoapPlayground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<SoapEngine | null>(null);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [coached, setCoached] = useState(true);
  const [canVibrate, setCanVibrate] = useState(false);

  // 저장된 설정·횟수 복원
  useEffect(() => {
    setSettings(load('slang:settings', DEFAULT_SETTINGS));
    const c = load('slang:count', { date: today(), n: 0 });
    setCount(c.date === today() ? c.n : 0);
    setCoached(load('slang:coach', { done: false }).done);
    setCanVibrate(typeof navigator !== 'undefined' && 'vibrate' in navigator);
  }, []);

  const onPress = useCallback(() => {
    setCoached((done) => {
      if (!done) save('slang:coach', { done: true });
      return true;
    });
    setCount((n) => {
      const next = n + 1;
      save('slang:count', { date: today(), n: next });
      return next;
    });
  }, []);

  // 3D 엔진은 브라우저에서만 불러온다
  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    import('@/lib/soap/engine')
      .then(({ SoapEngine }) => {
        if (cancelled) return;
        try {
          engineRef.current = new SoapEngine(canvas, {
            onProgress: setProgress,
            onReady: () => setReady(true),
            onError: setError,
            onPress,
          });
        } catch {
          setError('이 기기에서는 3D 화면을 열 수 없어요. 다른 브라우저로 열어 주세요.');
        }
      })
      .catch(() => setError('화면을 불러오지 못했어요. 새로고침해 주세요.'));
    return () => {
      cancelled = true;
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [onPress]);

  // 설정 반영
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    e.setSound(settings.sound);
    e.setHaptics(settings.haptics);
    e.setTint(settings.tint);
  }, [settings, ready]);

  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSheetOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheetOpen]);

  const update = (patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      save('slang:settings', next);
      return next;
    });
  };

  return (
    <main className="stage">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        aria-label="비누 말랑이. 손가락으로 누르거나, 스페이스바를 누르고 있으면 가운데를 눌러요."
      />

      <header className="header">
        <div>
          <h1>슬랑 비누</h1>
          <p>꾹 누르면 바삭, 놓으면 말랑해요</p>
        </div>
        <button className="icon-button" aria-label="설정 열기" onClick={() => setSheetOpen(true)}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 7h10M18 7h2M4 17h4M12 17h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <circle cx="16" cy="7" r="2" stroke="currentColor" strokeWidth="2" />
            <circle cx="10" cy="17" r="2" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>
      </header>

      {ready && !coached && <div className="coach" aria-hidden="true" />}

      <footer className="footer">
        {ready && !coached && <p className="hint">비누를 꾹 눌러보세요</p>}
        {ready && coached && (
          <p className="counter" aria-live="polite">
            오늘 <strong>{count.toLocaleString('ko-KR')}</strong>번 눌렀어요
          </p>
        )}
      </footer>

      {!ready && !error && (
        <div className="overlay" role="status">
          <div className="loading">
            비누 꺼내는 중
            <div className="bar">
              <span style={{ width: `${Math.round(Math.max(0.08, progress) * 100)}%` }} />
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="overlay">
          <div className="error-card" role="alert">
            <p>{error}</p>
            <button className="cta" onClick={() => location.reload()}>
              새로고침
            </button>
          </div>
        </div>
      )}

      {sheetOpen && (
        <>
          <div className="sheet-dim" onClick={() => setSheetOpen(false)} />
          <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
            <div className="sheet-handle" />
            <h2 id="sheet-title">설정</h2>

            <div className="row">
              <div className="row-text">
                <strong>소리</strong>
                <span>아이폰은 무음 모드를 끄면 들려요</span>
              </div>
              <button
                className="switch"
                role="switch"
                aria-checked={settings.sound}
                aria-label="소리"
                onClick={() => update({ sound: !settings.sound })}
              />
            </div>

            {canVibrate && (
              <div className="row">
                <div className="row-text">
                  <strong>진동</strong>
                  <span>누를 때 손끝으로 바삭함을 느껴요</span>
                </div>
                <button
                  className="switch"
                  role="switch"
                  aria-checked={settings.haptics}
                  aria-label="진동"
                  onClick={() => update({ haptics: !settings.haptics })}
                />
              </div>
            )}

            <div className="row-text" style={{ paddingTop: 10 }}>
              <strong id="tint-label">비누 색</strong>
            </div>
            <div className="tints" role="radiogroup" aria-labelledby="tint-label">
              {TINTS.map((t) => (
                <button
                  key={t.id}
                  className="tint"
                  role="radio"
                  aria-checked={settings.tint === t.id}
                  onClick={() => update({ tint: t.id })}
                >
                  <i style={{ ['--c' as string]: t.color }} />
                  {t.label}
                </button>
              ))}
            </div>

            <button className="cta" onClick={() => setSheetOpen(false)} autoFocus>
              확인
            </button>
          </section>
        </>
      )}
    </main>
  );
}
