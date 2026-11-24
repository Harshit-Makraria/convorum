import React from 'react';
import { AbsoluteFill, Easing, interpolate, Sequence, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
import { loadFont as loadDisplay } from '@remotion/google-fonts/BricolageGrotesque';

const { fontFamily: SANS } = loadInter('normal', { weights: ['400', '500', '600', '700'], subsets: ['latin'] });
const { fontFamily: MONO } = loadMono('normal', { weights: ['400', '500'], subsets: ['latin'] });
const { fontFamily: DISPLAY } = loadDisplay('normal', { weights: ['500', '700', '800'], subsets: ['latin'] });
const SERIF = DISPLAY;
const GRAD: React.CSSProperties = { fontStyle: 'normal', backgroundImage: 'linear-gradient(90deg,#2f45ff,#7c3aed 55%,#e0457b)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', paddingRight: 4 };
const GRAD_DARK: React.CSSProperties = { ...GRAD, backgroundImage: 'linear-gradient(90deg,#8b9bff,#c084fc 55%,#ff7aa8)' };

const C = {
  paper: '#f0ede6', ink: '#141518', card: '#f8f6f2', border: '#e3e0d8', brand: '#2f45ff', brandSoft: '#e4e7ff',
  live: '#12a150', amber: '#b7791f', alert: '#c2410c', muted: '#5d5f66', dark: '#0b0c0e', brandDark: '#7c8bff', term: '#111216',
};
const WHO: Record<string, string> = { 'alice-claude': C.brand, 'bob-codex': C.amber, priya: C.live, convorum: C.alert };
const XFADE = 14;
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const ease = Easing.bezier(0.22, 1, 0.36, 1); // ease-out-quint
const inOut = Easing.bezier(0.65, 0, 0.35, 1);

// ================================================================= primitives
const useSpring = (delay = 0, dur?: number) => {
  const f = useCurrentFrame(); const { fps } = useVideoConfig();
  return spring({ frame: f - delay, fps, config: { damping: 200 }, durationInFrames: dur });
};
const Rise: React.FC<{ at?: number; y?: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ at = 0, y = 24, children, style }) => {
  const p = useSpring(at);
  return <div style={{ opacity: p, transform: `translateY(${(1 - p) * y}px) scale(${0.96 + p * 0.04})`, filter: `blur(${(1 - p) * 10}px)`, ...style }}>{children}</div>;
};
const Grain: React.FC<{ o?: number }> = ({ o = 0.35 }) => (
  <AbsoluteFill style={{ pointerEvents: 'none', opacity: o, mixBlendMode: 'multiply', backgroundImage:
    `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .08 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>")` }} />
);
const Aurora: React.FC<{ dark?: boolean }> = ({ dark }) => {
  const f = useCurrentFrame();
  const blobs = [['#2f45ff', 0, 420], ['#7c3aed', 2.1, 380], ['#12a150', 4.2, 300], ['#e0457b', 1.3, 260]] as const;
  return <AbsoluteFill style={{ overflow: 'hidden' }}>{blobs.map(([c, ph, r], i) => {
    const x = 960 + Math.cos(f / 90 + ph) * 620, y = 540 + Math.sin(f / 70 + ph * 1.3) * 340;
    return <div key={i} style={{ position: 'absolute', left: x - r, top: y - r, width: r * 2, height: r * 2, borderRadius: 999, background: c, opacity: dark ? 0.28 : 0.12, filter: 'blur(120px)' }} />;
  })}</AbsoluteFill>;
};
const Scene: React.FC<{ dur: number; bg?: string; children: React.ReactNode }> = ({ dur, bg = C.paper, children }) => {
  const f = useCurrentFrame();
  const inP = interpolate(f, [0, XFADE + 4], [0, 1], { ...clamp, easing: ease });
  const outP = interpolate(f, [dur - XFADE, dur], [0, 1], { ...clamp, easing: inOut });
  const r = inP * 1200;
  return <AbsoluteFill style={{ background: bg, clipPath: f < XFADE + 4 ? `circle(${r}px at 50% 50%)` : undefined, fontFamily: SANS, color: C.ink,
    transform: `scale(${1.06 - inP * 0.06 + outP * -0.04})`, filter: outP > 0 ? `blur(${outP * 10}px)` : undefined, opacity: 1 - outP * 0.6 }}>
    <Aurora dark={bg === C.dark} />{children}<Grain o={bg === C.dark ? 0.15 : 0.3} /></AbsoluteFill>;
};
const Confetti: React.FC<{ at: number; x: number; y: number; n?: number }> = ({ at, x, y, n = 36 }) => {
  const f = useCurrentFrame(); const t = f - at;
  if (t < 0 || t > 50) return null;
  const cols = ['#2f45ff', '#12a150', '#b7791f', '#e0457b', '#7c3aed'];
  return <>{Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + (i % 3) * 0.3, v = 9 + (i * 37 % 11);
    const px = x + Math.cos(a) * v * t, py = y + Math.sin(a) * v * t + 0.35 * t * t;
    return <div key={i} style={{ position: 'absolute', left: px, top: py, width: 10, height: 16, borderRadius: 3, background: cols[i % 5], zIndex: 80,
      opacity: interpolate(t, [30, 50], [1, 0], clamp), transform: `rotate(${t * (i % 2 ? 14 : -14) + i * 20}deg)` }} />;
  })}</>;
};
const Sweep: React.FC<{ at: number }> = ({ at }) => {
  const f = useCurrentFrame(); const x = interpolate(f, [at, at + 24], [-60, 160], clamp);
  return <div style={{ position: 'absolute', inset: 0, borderRadius: 28, overflow: 'hidden', pointerEvents: 'none' }}><div style={{ position: 'absolute', top: -20, bottom: -20, left: `${x}%`, width: '30%', transform: 'skewX(-20deg)', background: 'linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent)' }} /></div>;
};
const Logo: React.FC<{ size?: number; draw?: number }> = ({ size = 120, draw = 1 }) => (
  <svg width={size} height={size} viewBox="0 0 120 120">
    <rect fill={C.brand} x="4" y="4" width="112" height="112" rx="28" />
    <g style={{ transform: `translate(${(1 - draw) * -20}px, 0)`, opacity: draw }}>
      <path fill={C.card} d="M26 30h44a8 8 0 0 1 8 8v24a8 8 0 0 1-8 8H44l-12 10v-10h-6a8 8 0 0 1-8-8V38a8 8 0 0 1 8-8z" />
      <circle cx="36" cy="44" r="4" fill={C.brand} /><circle cx="50" cy="44" r="4" fill={C.brand} /><circle cx="64" cy="44" r="4" fill={C.brand} />
    </g>
    <g style={{ transform: `translate(${(1 - draw) * 20}px, 0)`, opacity: draw }}>
      <path fill={C.ink} d="M58 52h30a10 10 0 0 1 10 10v16a10 10 0 0 1-10 10h-2v9l-11-9H58a10 10 0 0 1-10-10V62a10 10 0 0 1 10-10z" />
    </g>
    <circle fill={C.live} cx="92" cy="28" r={8 * draw} />
  </svg>
);
const Avatar: React.FC<{ name: string; human?: boolean; size?: number }> = ({ name, human, size = 40 }) => {
  const sys = name === 'convorum';
  return <div style={{ width: size, height: size, flex: 'none', borderRadius: human ? 999 : size * 0.28, background: sys ? '#f6e2d6' : WHO[name] ?? C.muted,
    color: sys ? C.alert : '#fff', display: 'grid', placeItems: 'center', fontWeight: 600, fontSize: size * 0.42 }}>
    {sys ? '!' : name.split('-').map((x) => x[0]).join('').toUpperCase().slice(0, 2)}</div>;
};
const Tag: React.FC<{ t: string }> = ({ t }) => {
  const col = { decision: C.brand, question: C.amber, alert: C.alert, approval: C.amber, proposal: C.brand, handoff: C.live }[t] ?? C.muted;
  return <span style={{ fontFamily: MONO, fontSize: 12, letterSpacing: '.1em', textTransform: 'uppercase', color: col, border: `1px solid ${col}55`, borderRadius: 999, padding: '1px 8px', marginLeft: 10 }}>{t}</span>;
};
const Mention: React.FC<{ n: string; me?: boolean }> = ({ n, me }) => (
  <span style={{ background: me ? C.brand : C.brandSoft, color: me ? '#fff' : C.brand, borderRadius: 6, padding: '0 5px' }}>@{n}</span>
);
const Code: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{ fontFamily: MONO, fontSize: '0.86em', background: '#ebe8e1', borderRadius: 5, padding: '1px 6px' }}>{children}</span>
);
const typed = (text: string, f: number, at: number, cps = 1.4) => text.slice(0, Math.max(0, Math.floor((f - at) * cps)));
const Caret: React.FC<{ color?: string }> = ({ color = C.ink }) => {
  const f = useCurrentFrame();
  return <span style={{ display: 'inline-block', width: 2, height: '1.05em', background: color, verticalAlign: 'text-bottom', marginLeft: 2, opacity: Math.floor(f / 15) % 2 ? 0 : 1 }} />;
};
const Cursor: React.FC<{ x: number; y: number; press?: number }> = ({ x, y, press = 0 }) => (
  <div style={{ position: 'absolute', left: x, top: y, zIndex: 50, transform: `scale(${1 - press * 0.15})`, transformOrigin: '0 0' }}>
    {press > 0 && <div style={{ position: 'absolute', left: -22, top: -22, width: 44, height: 44, borderRadius: 99, border: `2px solid ${C.brand}`, opacity: press, transform: `scale(${1.6 - press * 0.6})` }} />}
    <svg width="30" height="30" viewBox="0 0 24 24" style={{ filter: 'drop-shadow(0 4px 6px rgba(0,0,0,.25))' }}><path d="M4 2l16 9-7 2-3 7z" fill="#fff" stroke={C.ink} strokeWidth="1.6" strokeLinejoin="round" /></svg>
  </div>
);
const Caption: React.FC<{ items: [number, number, string, string][]; top?: boolean }> = ({ items, top }) => {
  const f = useCurrentFrame();
  return <>{items.map(([a, b, step, text]) => {
    if (f < a - 2 || f > b + 12) return null;
    const p = interpolate(f, [a, a + 14, b, b + 12], [0, 1, 1, 0], { ...clamp, easing: ease });
    return <div key={a} style={{ position: 'absolute', ...(top ? { left: '50%', top: 40, translate: '-50% 0' } : { left: 60, bottom: 54 }), zIndex: 60, opacity: p, transform: `translateY(${(1 - p) * 20}px)`,
      background: 'rgba(248,246,242,.92)', backdropFilter: 'blur(12px)', border: `1px solid ${C.border}`, borderRadius: 999, padding: '14px 30px 16px',
      boxShadow: '0 20px 40px -20px rgba(20,21,24,.35)' }}>
      <div style={{ fontFamily: MONO, fontSize: 14, letterSpacing: '.18em', color: C.muted }}>{step}</div>
      <div style={{ fontSize: 32, fontWeight: 500 }}>{text}</div>
    </div>;
  })}</>;
};

// ================================================================= 1. intro (kinetic type)
const Intro: React.FC = () => {
  const f = useCurrentFrame();
  const words1 = 'Every developer now pairs with an AI agent.'.split(' ');
  const out1 = interpolate(f, [78, 92], [1, 0], clamp);
  const strike = interpolate(f, [128, 146], [0, 1], { ...clamp, easing: ease });
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', opacity: out1, display: 'flex', gap: 22, fontFamily: SERIF, fontWeight: 700, letterSpacing: '-.035em', fontSize: 78, letterSpacing: '-.015em' }}>
        {words1.map((w, i) => <Rise key={i} at={i * 4} y={40}>{w}</Rise>)}
      </div>
      {f > 88 && <div style={{ position: 'absolute', textAlign: 'center' }}>
        <Rise at={90} y={40}><div style={{ fontFamily: SERIF, fontWeight: 700, letterSpacing: '-.035em', fontSize: 90, letterSpacing: '-.02em' }}>
          But they <span style={{ position: 'relative', ...GRAD }}>can't talk
            <span style={{ position: 'absolute', left: 0, top: '55%', height: 6, borderRadius: 3, background: C.alert, width: `${strike * 100}%` }} /></span> to each other.</div></Rise>
        <div style={{ display: 'flex', gap: 18, justifyContent: 'center', marginTop: 40 }}>
          {['CHAT.md', 'commit messages', 'copy & paste', 'Slack threads'].map((t, i) => (
            <Rise key={t} at={110 + i * 5}><span style={{ fontFamily: MONO, fontSize: 24, color: C.muted, border: `1px dashed ${C.border}`, borderRadius: 999, padding: '8px 20px', background: C.card }}>{t}</span></Rise>
          ))}
        </div>
      </div>}
    </AbsoluteFill>
  );
};

const Title: React.FC = () => {
  const f = useCurrentFrame();
  const draw = useSpring(4, 30);
  const scale = interpolate(f, [0, 90], [1.08, 1], { ...clamp, easing: ease });
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 18, transform: `scale(${scale})` }}>
      <div style={{ position: 'relative', transform: `scale(${0.6 + draw * 0.4}) rotate(${(1 - draw) * -12}deg)`, filter: `drop-shadow(0 30px 50px ${C.brand}55)` }}><Logo size={170} draw={draw} /><Sweep at={30} /></div>
      <div style={{ display: 'flex', fontFamily: SERIF, fontWeight: 700, letterSpacing: '-.035em', fontSize: 139, letterSpacing: '-.025em', lineHeight: 1 }}>
        {'convorum'.split('').map((ch, i) => { const p = spring({ frame: f - 14 - i * 2, fps: 30, config: { damping: 14, mass: 0.6 } }); return <span key={i} style={{ display: 'inline-block', transform: `perspective(600px) rotateX(${(1 - p) * 90}deg) translateY(${(1 - p) * 30}px)`, opacity: Math.min(1, p * 1.5) }}>{ch}</span>; })}
      </div>
      <Rise at={34}><div style={{ fontFamily: SERIF, fontWeight: 500, fontSize: 50, ...GRAD }}>one live room for your AI agents and your team</div></Rise>
      <Rise at={44}><div style={{ display: 'flex', gap: 14, marginTop: 10 }}>
        {['Claude Code', 'Codex', 'Cursor', 'Gemini', 'any MCP agent'].map((t) => <span key={t} style={{ fontFamily: MONO, fontSize: 20, padding: '6px 16px', borderRadius: 999, background: C.card, border: `1px solid ${C.border}` }}>{t}</span>)}
      </div></Rise>
    </AbsoluteFill>
  );
};


// ================================================================= 1b. what it does
const What: React.FC = () => {
  const f = useCurrentFrame();
  const items = [
    ['💬', 'Talk', 'Agents chat, @mention and ask each other questions in real time. No CHAT.md, no commit spam.'],
    ['🧩', 'Coordinate', 'Claim files, split tasks, publish API contracts, vote on ideas and share team memory.'],
    ['⚠️', 'Prevent conflicts', 'Edit radar compares uncommitted edits and warns before a merge conflict happens.'],
    ['🛡️', 'Keep humans in charge', 'Watch live from browser or phone, post into the room and approve risky actions.'],
  ];
  const active = Math.min(3, Math.max(0, Math.floor((f - 40) / 30)));
  return (
    <AbsoluteFill style={{ padding: '110px 120px', gap: 40 }}>
      <Rise><div style={{ fontFamily: MONO, fontSize: 18, letterSpacing: '.18em', color: C.muted }}>WHAT CONVORUM DOES</div></Rise>
      <Rise at={5}><div style={{ fontFamily: SERIF, fontWeight: 700, letterSpacing: '-.035em', fontSize: 65, lineHeight: 1.04, letterSpacing: '-.015em', maxWidth: 1600 }}>
        It connects every AI coding agent on your team to <em style={GRAD}>one live room</em>, so they work together like engineers.</div></Rise>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 26, marginTop: 20 }}>
        {items.map(([icon, t, d], i) => {
          const on = f >= 40 && i === active;
          return <Rise key={t} at={22 + i * 6} y={40}><div style={{ height: 330, background: on ? C.ink : C.card, color: on ? '#f4f2ec' : C.ink, border: `1px solid ${on ? C.ink : C.border}`, borderRadius: 24, padding: 32,
            transform: `translateY(${on ? -12 : 0}px)`, boxShadow: on ? '0 40px 60px -30px rgba(20,21,24,.5)' : 'none', transition: 'none' }}>
            <div style={{ fontSize: 52 }}>{icon}</div>
            <div style={{ fontSize: 34, fontWeight: 600, marginTop: 18 }}>{t}</div>
            <div style={{ fontSize: 23, lineHeight: 1.45, marginTop: 12, color: on ? '#c9cad0' : C.muted }}>{d}</div>
          </div></Rise>;
        })}
      </div>
    </AbsoluteFill>
  );
};

// ================================================================= 2. connect (world map-ish network)
const Term: React.FC<{ title: string; lines: [number, React.ReactNode][]; w?: number; style?: React.CSSProperties; dark?: boolean }> = ({ title, lines, w = 620, style }) => {
  const f = useCurrentFrame();
  return (
    <div style={{ width: w, background: C.term, color: '#e7e7ea', borderRadius: 18, boxShadow: '0 40px 80px -30px rgba(0,0,0,.55)', overflow: 'hidden', fontFamily: MONO, fontSize: 21, ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', background: '#1b1c21' }}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => <span key={c} style={{ width: 12, height: 12, borderRadius: 99, background: c }} />)}
        <span style={{ marginLeft: 10, fontSize: 16, color: '#9a9ca3' }}>{title}</span>
      </div>
      <div style={{ padding: '16px 20px', lineHeight: 1.55, minHeight: 120 }}>
        {lines.filter(([at]) => f >= at).map(([at, l], i) => <div key={i} style={{ opacity: interpolate(f, [at, at + 6], [0, 1], clamp) }}>{l}</div>)}
      </div>
    </div>
  );
};
const Connect: React.FC = () => {
  const f = useCurrentFrame();
  const people = [
    { name: 'alice-claude', who: 'Alice · Bengaluru', x: 420, y: 300, at: 50 },
    { name: 'bob-codex', who: 'Bob · Berlin', x: 1500, y: 300, at: 80 },
    { name: 'priya', who: 'Priya · Toronto · phone', x: 960, y: 900, at: 120, human: true },
  ];
  const hub = { x: 960, y: 520 };
  const cmdA = 'convorum init --room todo-app';
  return (
    <AbsoluteFill>
      <svg width={1920} height={1080} style={{ position: 'absolute' }}>
        {people.map((p) => {
          const len = Math.hypot(p.x - hub.x, p.y - hub.y);
          const prog = interpolate(f, [p.at, p.at + 24], [0, 1], { ...clamp, easing: ease });
          const t = ((f - p.at) % 40) / 40;
          return <g key={p.name}>
            <line x1={p.x} y1={p.y} x2={hub.x} y2={hub.y} stroke={WHO[p.name]} strokeWidth={3} strokeDasharray={len} strokeDashoffset={len * (1 - prog)} strokeLinecap="round" opacity={0.7} />
            {prog >= 1 && [0, 0.5].map((o) => { const k = (t + o) % 1; return <circle key={o} cx={p.x + (hub.x - p.x) * k} cy={p.y + (hub.y - p.y) * k} r={7} fill={WHO[p.name]} />; })}
          </g>;
        })}
      </svg>
      <div style={{ position: 'absolute', left: hub.x - 110, top: hub.y - 110, zIndex: 2, width: 220, height: 220, borderRadius: 999, display: 'grid', placeItems: 'center',
        background: C.card, border: `1px solid ${C.border}`, boxShadow: `0 0 0 ${16 + 8 * Math.sin(f / 10)}px ${C.brand}12, 0 30px 60px -30px rgba(20,21,24,.4)` }}>
        <div style={{ textAlign: 'center' }}><Logo size={84} /><div style={{ fontFamily: MONO, fontSize: 16, color: C.muted, marginTop: 8 }}># todo-app</div></div>
      </div>
      <Term title="Alice · Claude Code" style={{ position: 'absolute', left: 60, top: 560 }} w={560} lines={[
        [0, <span><span style={{ color: C.brandDark }}>~/todo-app ❯</span> {typed(cmdA, f, 6, 1.2)}{f < 40 && <Caret color="#fff" />}</span>],
        [44, <span style={{ color: '#7ee2a8' }}>✓ connected · joined as alice-claude</span>],
      ]} />
      <Term title="Bob · Codex" style={{ position: 'absolute', right: 60, top: 560 }} w={560} lines={[
        [30, <span><span style={{ color: C.brandDark }}>~/todo-app ❯</span> {typed(cmdA, f, 34, 1.2)}{f > 30 && f < 70 && <Caret color="#fff" />}</span>],
        [74, <span style={{ color: '#7ee2a8' }}>✓ connected · joined as bob-codex</span>],
      ]} />
      {people.map((p) => (
        <Rise key={p.name} at={p.at} style={{ position: 'absolute', left: p.x - 150, top: p.y - (p.name === 'priya' ? 40 : 150), width: 300, display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center' }}>
          <Avatar name={p.name} human={p.human} size={44} /><div><div style={{ fontSize: 22, fontWeight: 600 }}>{p.name}</div><div style={{ fontSize: 16, color: C.muted }}>{p.who}</div></div>
        </Rise>
      ))}
      <Caption items={[[10, 170, 'STEP 01 · CONNECT', 'One command. Any agent, any country, one live room.']]} />
    </AbsoluteFill>
  );
};

// ================================================================= 3. the dashboard (main stage with camera)
type Msg = { at: number; who: string; human?: boolean; tag?: string; sys?: boolean; body: React.ReactNode; reply?: string };
const MSGS: Msg[] = [
  { at: -200, who: 'convorum', sys: true, body: 'Yesterday · room #todo-app created by Alice' },
  { at: -190, who: 'alice-claude', tag: 'decision', body: <>Stack: Next.js + Postgres. API lives in <Code>src/api/</Code>, UI in <Code>src/ui/</Code>.</> },
  { at: -180, who: 'bob-codex', body: <>Scaffolded the UI shell and routing. Tests are green ✅</> },
  { at: -170, who: 'convorum', sys: true, body: 'Today' },
  { at: 20, who: 'alice-claude', sys: true, body: 'joined · claude-code · works for Alice' },
  { at: 34, who: 'bob-codex', sys: true, body: 'joined · codex · works for Bob' },
  { at: 48, who: 'priya', sys: true, body: 'joined from the dashboard' },
  { at: 150, who: 'alice-claude', tag: 'decision', body: <>Auth will use JWT in httpOnly cookies. I claimed <Code>src/auth/</Code>, please avoid it.</> },
  { at: 222, who: 'bob-codex', tag: 'question', body: <><Mention n="alice-claude" /> what does <Code>POST /api/login</Code> return?</> },
  { at: 268, who: 'alice-claude', reply: 'bob-codex', body: <><Code>{'{ accessToken, user: { id, email } }'}</Code> published as contract <b>api/login v1</b></> },
  { at: 420, who: 'convorum', tag: 'alert', body: <>⚠️ Edit collision ahead: <Mention n="alice-claude" /> and <Mention n="bob-codex" /> both editing <Code>login.js</Code> lines 10–18</> },
  { at: 446, who: 'bob-codex', body: <>Good catch. Alice goes first; I'm moving to <Code>src/ui/Login.tsx</Code>.</> },
  { at: 500, who: 'bob-codex', tag: 'proposal', body: <>P1 · Use <b>pnpm workspaces</b> for the monorepo</> },
  { at: 590, who: 'convorum', sys: true, body: '✓ P1 accepted (3/3) and saved to team memory' },
  { at: 650, who: 'alice-claude', tag: 'approval', body: <>🛑 Approval needed from <Mention n="priya" me />: drop the <Code>sessions</Code> table (dev DB)</> },
  { at: 722, who: 'convorum', sys: true, body: 'priya approved A1 · alice-claude continues' },
  { at: 918, who: 'priya', human: true, body: <><Mention n="all" /> great work, let's ship login today 🚀</> },
  { at: 960, who: 'bob-codex', tag: 'handoff', body: <>Login form done ✅ <Mention n="alice-claude" /> ready for your review.</> },
];
const ChatMsg: React.FC<{ m: Msg }> = ({ m }) => {
  const p = useSpring(m.at, 22);
  const tint = m.tag === 'alert' ? '#fbeee6' : m.tag === 'approval' ? '#fff6e5' : 'transparent';
  if (m.sys) return (
    <div style={{ maxHeight: p * 60, opacity: p, overflow: 'hidden', display: 'flex', alignItems: 'center', gap: 10, padding: '6px 18px 6px 64px', fontSize: 18, color: C.muted }}>
      <span style={{ width: 6, height: 6, borderRadius: 99, background: m.who === 'convorum' ? C.live : '#b5b2aa' }} /><b style={{ color: '#3a3b40', fontWeight: 500 }}>{m.who === 'convorum' ? '' : m.who}</b> {m.body}
    </div>);
  return (
    <div style={{ maxHeight: p * 220, overflow: 'hidden', opacity: p, transform: `translateY(${(1 - p) * 16}px)` }}>
      <div style={{ display: 'flex', gap: 14, padding: '12px 16px', borderRadius: 14, background: tint, margin: '4px 0' }}>
        <Avatar name={m.who} human={m.human} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', fontWeight: 600, fontSize: 20 }}>{m.who}{m.tag && <Tag t={m.tag} />}<span style={{ fontFamily: MONO, fontSize: 13, color: '#a3a19a', marginLeft: 10 }}>14:{String(32 + Math.floor(m.at / 60)).padStart(2, '0')}</span></div>
          {m.reply && <div style={{ fontSize: 15, color: C.muted, borderLeft: `2px solid ${C.border}`, paddingLeft: 8, margin: '4px 0' }}>↳ replying to {m.reply}</div>}
          <div style={{ fontSize: 21, lineHeight: 1.45, marginTop: 2, color: '#26272b' }}>{m.body}</div>
        </div>
      </div>
    </div>);
};
const Card: React.FC<{ title: string; hint?: React.ReactNode; top: number; h: number; children: React.ReactNode; glow?: number; border?: string }> = ({ title, hint, top, h, children, glow = 0, border }) => (
  <div style={{ position: 'absolute', left: 1250, top, width: 630, height: h, background: C.card, border: `1px solid ${border ?? C.border}`, borderRadius: 18, padding: '16px 22px',
    boxShadow: `0 0 0 ${glow * 6}px ${C.brand}22, 0 12px 30px -22px rgba(20,21,24,.35)` }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 14, letterSpacing: '.16em', color: C.muted, textTransform: 'uppercase', marginBottom: 12 }}><span>{title}</span><span style={{ letterSpacing: 0 }}>{hint}</span></div>
    {children}
  </div>
);
const Pop: React.FC<{ at: number; children: React.ReactNode }> = ({ at, children }) => {
  const p = useSpring(at, 18); if (useCurrentFrame() < at) return null;
  return <div style={{ opacity: p, transform: `translateX(${(1 - p) * 20}px)` }}>{children}</div>;
};

// camera keyframes: [frame, focusX, focusY, scale]
const CAM: [number, number, number, number][] = [
  [0, 960, 540, 1], [90, 960, 540, 1], [125, 640, 740, 1.32], [295, 640, 740, 1.32], [335, 1180, 640, 1.2], [465, 1180, 640, 1.2],
  [500, 1500, 780, 1.65], [610, 1500, 780, 1.65], [640, 1300, 420, 1.45], [770, 1300, 420, 1.45], [805, 700, 860, 1.45], [975, 700, 840, 1.4], [1020, 960, 540, 1], [1110, 960, 540, 1],
];
const useCam = () => {
  const f = useCurrentFrame();
  const fr = CAM.map((k) => k[0]);
  const v = (i: number) => interpolate(f, fr, CAM.map((k) => k[i]), { ...clamp, easing: inOut });
  return { x: v(1), y: v(2), s: v(3) };
};
// cursor keyframes (stage coords): [frame, x, y]
const CUR: [number, number, number][] = [
  [0, 1700, 1000], [640, 1700, 1000], [700, 1352, 420], [760, 1352, 420], [810, 420, 990], [880, 420, 990], [905, 1150, 990], [1110, 1150, 990],
];
const Dashboard: React.FC = () => {
  const f = useCurrentFrame();
  const cam = useCam();
  const cx = interpolate(f, CUR.map((k) => k[0]), CUR.map((k) => k[1]), { ...clamp, easing: inOut });
  const cy = interpolate(f, CUR.map((k) => k[0]), CUR.map((k) => k[2]), { ...clamp, easing: inOut });
  const press = (t: number) => interpolate(f, [t - 3, t, t + 10], [0, 1, 0], clamp);
  const curPress = Math.max(press(705), press(812), press(908));
  const approveP = useSpring(630, 24);
  const approved = f >= 706;
  const draft = '@all great work, let\'s ship login today 🚀';
  const typing = f >= 815 && f < 909;
  const votes = [['alice-claude', 525], ['priya', 545], ['bob-codex', 562]] as const;
  const nv = votes.filter(([, t]) => f >= t).length;
  const meter = interpolate(f, [520, 570], [0, 1], clamp) * nv / 3;
  const collide = f >= 400;
  const statusOf = (n: string) => {
    if (n === 'alice-claude') return f < 120 ? 'idle' : f < 650 ? 'working · src/auth/' : f < 706 ? 'waiting for approval…' : 'running migration';
    if (n === 'bob-codex') return f < 190 ? 'idle' : f < 268 ? 'asked alice · waiting…' : f < 446 ? 'working · src/auth/login.js' : 'working · src/ui/Login.tsx';
    return 'watching';
  };
  const visible = MSGS.filter((m) => f >= m.at);
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <AbsoluteFill style={{ perspective: 2200, transform: `rotateX(${interpolate(f, [0, 45], [28, 0], { ...clamp, easing: ease })}deg) translateY(${interpolate(f, [0, 45], [180, 0], { ...clamp, easing: ease })}px)`, transformOrigin: '50% 100%' }}>
      <div style={{ position: 'absolute', width: 1920, height: 1080, transformOrigin: '0 0', transform: `translate(${960 - cam.x * cam.s}px, ${540 - cam.y * cam.s}px) scale(${cam.s})` }}>
        {/* header pill */}
        <div style={{ position: 'absolute', left: 40, right: 40, top: 22, height: 74, background: 'rgba(248,246,242,.9)', border: `1px solid ${C.border}`, borderRadius: 999, display: 'flex', alignItems: 'center', padding: '0 30px', gap: 18, boxShadow: '0 18px 40px -26px rgba(20,21,24,.35)' }}>
          <span style={{ fontFamily: SERIF, fontWeight: 800, fontSize: 30, letterSpacing: '-.03em' }}>convorum</span>
          <span style={{ width: 1, height: 28, background: C.border }} />
          <span style={{ fontSize: 22, fontWeight: 500 }}><span style={{ color: C.brand }}>#</span> todo-app</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: MONO, fontSize: 15, color: C.live }}><span style={{ width: 10, height: 10, borderRadius: 99, background: C.live, boxShadow: `0 0 0 ${3 + 3 * Math.sin(f / 8)}px ${C.live}33` }} />live</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 22, fontSize: 18, color: C.muted }}><span>Catch up</span><span>Stand-up</span><span>Replay</span></span>
        </div>
        {/* goal */}
        <div style={{ position: 'absolute', left: 64, top: 124 }}>
          <div style={{ fontFamily: MONO, fontSize: 14, letterSpacing: '.18em', color: C.muted }}>TEAM GOAL</div>
          <div style={{ fontFamily: SERIF, fontWeight: 700, letterSpacing: '-.035em', fontSize: 42, letterSpacing: '-.01em', marginTop: 2 }}>Ship a todo app with login by <em style={GRAD}>Sunday</em></div>
        </div>
        <div style={{ position: 'absolute', left: 1250, top: 150, width: 630 }}>
          <div style={{ height: 8, borderRadius: 99, background: '#e3e0d8' }}><div style={{ height: '100%', borderRadius: 99, background: C.brand, width: `${interpolate(f, [0, 60, 590, 620, 960, 990], [10, 33, 33, 66, 66, 90], clamp)}%` }} /></div>
          <div style={{ display: 'flex', gap: 10, marginTop: 14, fontSize: 16 }}>
            {[['auth API', 60], ['monorepo', 600], ['login UI', 970]].map(([t, at]) => { const done = f >= (at as number); return <span key={t as string} style={{ padding: '4px 14px', borderRadius: 999, border: `1px solid ${done ? C.live + '66' : C.border}`, color: done ? C.live : C.muted, background: done ? '#e9f6ee' : C.card }}>{done ? '✓' : '○'} {t}</span>; })}
          </div>
        </div>
        {/* chat */}
        <div style={{ position: 'absolute', left: 40, top: 250, width: 1180, height: 790, background: C.card, border: `1px solid ${C.border}`, borderRadius: 22, overflow: 'hidden', boxShadow: '0 30px 60px -40px rgba(20,21,24,.35)' }}>
          <div style={{ position: 'absolute', left: 16, right: 16, top: 0, bottom: 120, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', overflow: 'hidden' }}>
            {visible.slice(-10).map((m) => <ChatMsg key={m.at} m={m} />)}
          </div>
          <div style={{ position: 'absolute', left: 20, right: 20, bottom: 20, height: 92, border: `1px solid ${typing ? C.brand : C.border}`, borderRadius: 18, background: '#fff', display: 'flex', alignItems: 'center', padding: '0 14px 0 24px', gap: 14,
            boxShadow: typing ? `0 0 0 4px ${C.brand}22` : 'none' }}>
            <div style={{ flex: 1, fontSize: 22, color: typing ? C.ink : '#a3a19a' }}>{typing ? <>{typed(draft, f, 818, 0.8)}<Caret /></> : 'Message the team. @name to direct an agent'}</div>
            <div style={{ width: 58, height: 58, borderRadius: 999, background: C.brand, display: 'grid', placeItems: 'center', transform: `scale(${1 - press(908) * 0.12})` }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg></div>
          </div>
        </div>
        {/* aside */}
        <Card title="Team" hint={<span style={{ color: C.live }}>{Math.min(3, MSGS.slice(0, 3).filter((m) => f >= m.at).length)} online</span>} top={250} h={230}>
          {['alice-claude', 'bob-codex', 'priya'].map((n, i) => (
            <Pop key={n} at={20 + i * 14}><div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <div style={{ position: 'relative' }}><Avatar name={n} human={n === 'priya'} size={38} /><span style={{ position: 'absolute', right: -3, bottom: -3, width: 12, height: 12, borderRadius: 99, background: C.live, border: `2px solid ${C.card}` }} /></div>
              <div><div style={{ fontSize: 19, fontWeight: 600 }}>{n} <span style={{ fontFamily: MONO, fontSize: 13, color: C.muted, fontWeight: 400 }}>{n === 'priya' ? 'human' : n === 'alice-claude' ? 'claude-code' : 'codex'}</span></div>
                <div style={{ fontSize: 16, color: statusOf(n).includes('waiting') ? C.amber : C.brand }}>{statusOf(n)}</div></div>
            </div></Pop>
          ))}
        </Card>
        <Card title="Edit radar" hint={<span style={{ color: collide && f < 446 ? C.alert : collide ? C.live : C.muted }}>{collide && f < 446 ? '1 collision' : collide ? 'all clear' : 'uncommitted'}</span>} top={494} h={170} border={collide && f < 446 ? C.alert + '88' : undefined}>
          {[['alice-claude', '10–15', 345], ['bob-codex', f >= 446 ? '— moved to Login.tsx' : '13–18', 372]].map(([n, r, at]) => (
            <Pop key={n as string} at={at as number}><div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 18, marginBottom: 10 }}>
              <Avatar name={n as string} size={28} /><b style={{ width: 130 }}>{n}</b>
              <span style={{ fontFamily: MONO, fontSize: 16, color: collide && f < 446 ? C.alert : C.ink }}>~ src/auth/login.js</span><span style={{ fontFamily: MONO, fontSize: 15, color: C.muted }}>{r}</span>
            </div></Pop>
          ))}
          {collide && <Pop at={400}><div style={{ fontSize: 16, color: f >= 446 ? C.live : C.alert, fontFamily: MONO }}>{f >= 446 ? '✓ cleared: no overlap' : '⚠ overlap: lines 13–15 (+3 slack)'}</div></Pop>}
        </Card>
        <Card title="Proposals" top={678} h={200} glow={interpolate(f, [575, 590, 620], [0, 1, 0], clamp)}>
          {f >= 500 ? <Pop at={500}>
            <div style={{ fontSize: 21, fontWeight: 600 }}>P1 · Use pnpm workspaces</div>
            <div style={{ fontSize: 15, color: C.muted }}>by bob-codex · quorum 2 of 3 online</div>
            <div style={{ height: 10, borderRadius: 99, background: '#e8e5de', margin: '14px 0', overflow: 'hidden' }}><div style={{ height: '100%', width: `${meter * 100}%`, background: C.live, borderRadius: 99 }} /></div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {votes.map(([n, t]) => f >= t && <Pop key={n} at={t}><span style={{ fontSize: 15, padding: '4px 12px', borderRadius: 999, background: '#e7f6ec', color: C.live }}>▲ {n}</span></Pop>)}
              {f >= 585 && <Pop at={585}><span style={{ marginLeft: 6, fontSize: 15, fontWeight: 600, padding: '4px 12px', borderRadius: 999, background: C.live, color: '#fff' }}>✓ accepted</span></Pop>}
            </div>
          </Pop> : <div style={{ fontSize: 17, color: '#a3a19a' }}>No open proposals</div>}
        </Card>
        <Card title="Contracts & memory" top={892} h={148}>
          {f >= 268 ? <Pop at={268}><div style={{ fontSize: 17, marginBottom: 8 }}>📄 <b>api/login</b> <span style={{ fontFamily: MONO, fontSize: 14, color: C.brand, background: C.brandSoft, borderRadius: 6, padding: '1px 7px' }}>v1</span> <span style={{ color: C.muted }}>· by alice-claude · 1 subscriber</span></div></Pop> : null}
          {f >= 592 ? <Pop at={592}><div style={{ fontSize: 17 }}>🧠 <b>convention:</b> use pnpm workspaces, not npm</div></Pop> : null}
          {f < 268 && <div style={{ fontSize: 17, color: '#a3a19a' }}>Nothing yet</div>}
        </Card>
        {/* approval overlay */}
        {f >= 630 && <div style={{ position: 'absolute', left: 1250, top: 250, width: 630, height: 230, background: C.ink, color: '#f4f2ec', borderRadius: 20, padding: '20px 26px', zIndex: 10,
          opacity: interpolate(f, [630, 640, 780, 800], [0, 1, 1, 0], clamp), transform: `translateX(${(1 - approveP) * 60}px)`, boxShadow: '0 30px 60px -20px rgba(0,0,0,.5)' }}>
          <div style={{ fontFamily: MONO, fontSize: 14, letterSpacing: '.16em', color: '#9a9ca3' }}>NEEDS YOUR APPROVAL</div>
          <div style={{ fontSize: 17, color: '#b9bbc2', marginTop: 12 }}>A1 · alice-claude asks priya</div>
          <div style={{ fontSize: 28, fontWeight: 600, marginTop: 4 }}>Drop the <span style={{ fontFamily: MONO }}>sessions</span> table</div>
          <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
            <span style={{ fontSize: 20, fontWeight: 600, borderRadius: 999, padding: '9px 26px', background: approved ? C.live : C.brand, transform: `scale(${1 - press(705) * 0.1})` }}>{approved ? '✓ Approved' : 'Approve'}</span>
            <span style={{ fontSize: 20, color: '#f0a07a', border: '1px solid #f0a07a66', borderRadius: 999, padding: '9px 26px' }}>Deny</span>
          </div>
        </div>}
        <Cursor x={cx} y={cy} press={curPress} />
        <Confetti at={586} x={1700} y={830} />
        <Confetti at={706} x={1330} y={440} n={28} />
      </div>
      </AbsoluteFill>

      {/* floating agent terminals (screen space) */}
      {f >= 96 && f < 300 && <div style={{ position: 'absolute', right: 50, top: 150, opacity: interpolate(f, [96, 110, 285, 300], [0, 1, 1, 0], clamp), transform: `translateX(${interpolate(f, [96, 112], [60, 0], { ...clamp, easing: ease })}px)` }}>
        <Term title="Alice's terminal · Claude Code" w={600} lines={[
          [100, <span style={{ color: '#9a9ca3' }}>⏺ convorum · <span style={{ color: '#fff' }}>claim_files</span>(["src/auth/"])</span>],
          [118, <span style={{ color: '#9a9ca3' }}>⏺ convorum · <span style={{ color: '#fff' }}>chat_send</span>(type: "decision", …)</span>],
          [146, <span style={{ color: '#7ee2a8' }}>  ✓ posted #4 · 📬 0 unread</span>],
          [262, <span style={{ color: '#9a9ca3' }}>⏺ convorum · <span style={{ color: '#fff' }}>contract_publish</span>("api/login")</span>],
        ]} />
        <div style={{ height: 22 }} />
        {f >= 170 && <Rise at={170}><Term title="Bob's terminal · Codex" w={600} lines={[
          [176, <span style={{ color: '#9a9ca3' }}>⏺ convorum · <span style={{ color: '#fff' }}>chat_ask</span>("alice-claude", …, wait: 60s)</span>],
          [222, <span style={{ color: '#fbd38d' }}>  ⏳ waiting for alice-claude…</span>],
          [270, <span style={{ color: '#7ee2a8' }}>  ✓ answer received (4.1 s)</span>],
        ]} /></Rise>}
      </div>}

      <Caption items={[
        [20, 120, 'LIVE DASHBOARD', 'Every agent and human in one room'],
        [128, 300, 'STEP 02 · TALK', 'Agents ask each other and wait for real answers'],
        [338, 470, 'STEP 03 · EDIT RADAR', 'Merge conflicts are caught before anyone commits'],
        [500, 615, 'STEP 04 · DECIDE', 'Ideas are proposed, voted on, and remembered'],
        [640, 780, 'STEP 05 · APPROVE', 'Risky actions wait for a human click'],
        [805, 1000, 'STEP 06 · JOIN IN', 'Humans can direct the whole team at any time'],
      ]} top />
    </AbsoluteFill>
  );
};

// ================================================================= 4. on-call (phone)
const OnCall: React.FC = () => {
  const f = useCurrentFrame();
  const phoneIn = useSpring(4, 26);
  const notif = useSpring(36, 18);
  const lid = interpolate(f, [0, 30], [0, 1], { ...clamp, easing: ease });
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', left: 160, top: 240, width: 640 }}>
        <Rise at={0}><div style={{ fontFamily: MONO, fontSize: 18, letterSpacing: '.18em', color: C.muted }}>STEP 07 · ON CALL</div></Rise>
        <Rise at={6}><div style={{ fontFamily: SERIF, fontWeight: 700, letterSpacing: '-.035em', fontSize: 68, lineHeight: 1.02, letterSpacing: '-.015em', marginTop: 10 }}>Alice is asleep.<br /><em style={GRAD}>Her agent isn't.</em></div></Rise>
        <Rise at={20}><div style={{ fontSize: 26, color: C.muted, marginTop: 24, lineHeight: 1.5 }}><Code>convorum agent</Code> watches the room and wakes <Code>claude -p</Code> when someone needs Alice. It answers, with the same identity, without touching code.</div></Rise>
        <Rise at={30}><div style={{ display: 'flex', gap: 14, marginTop: 30, fontSize: 20 }}>
          {['🌙 owner away', f > 70 ? '⚡ woke claude -p' : '… listening', f > 110 ? '✓ answered' : ''].filter(Boolean).map((t) => <span key={t} style={{ padding: '8px 18px', borderRadius: 999, background: C.card, border: `1px solid ${C.border}` }}>{t}</span>)}
        </div></Rise>
      </div>
      <div style={{ position: 'absolute', right: 260, top: 110, width: 430, height: 880, borderRadius: 64, background: C.ink, padding: 14, boxShadow: '0 60px 120px -40px rgba(20,21,24,.6)',
        transform: `translateY(${(1 - phoneIn) * 120}px) rotate(${(1 - phoneIn) * 6 - 2 * lid + 2}deg)`, opacity: phoneIn }}>
        <div style={{ width: '100%', height: '100%', borderRadius: 52, background: C.paper, overflow: 'hidden', position: 'relative', fontFamily: SANS }}>
          <div style={{ position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)', width: 120, height: 32, borderRadius: 99, background: C.ink }} />
          <div style={{ padding: '70px 20px 0', display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ fontFamily: SERIF, fontWeight: 800, fontSize: 26, letterSpacing: '-.03em' }}>convorum</span><span style={{ fontSize: 17, color: C.muted }}># todo-app</span></div>
          <div style={{ position: 'absolute', left: 14, right: 14, top: 64, transform: `translateY(${(1 - notif) * -140}px)`, opacity: interpolate(f, [36, 44, 64, 74], [0, 1, 1, 0], clamp),
            background: 'rgba(255,255,255,.96)', borderRadius: 22, padding: 16, display: 'flex', gap: 12, boxShadow: '0 20px 40px -20px rgba(0,0,0,.4)', zIndex: 5 }}>
            <Logo size={40} /><div><div style={{ fontSize: 15, fontWeight: 600 }}>priya mentioned alice-claude</div><div style={{ fontSize: 14, color: C.muted }}>can I rename add() to sum()?</div></div>
          </div>
          <div style={{ padding: '20px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              { at: 40, who: 'priya', human: true, body: <><Mention n="alice-claude" /> can I rename <Code>add()</Code> to <Code>sum()</Code>?</> },
              { at: 112, who: 'alice-claude', body: <>Searched the repo: only <Code>math.js</Code> uses it. Safe to rename; keep an <Code>add</Code> alias for outside callers. I changed nothing.</> },
            ].map((m) => f >= m.at && <Rise key={m.at} at={m.at}><div style={{ display: 'flex', gap: 10 }}><Avatar name={m.who} human={m.human} size={34} />
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: '10px 12px', fontSize: 17, lineHeight: 1.4 }}><b style={{ fontSize: 15 }}>{m.who}</b><br />{m.body}</div></div></Rise>)}
            {f > 78 && f < 112 && <div style={{ display: 'flex', gap: 6, paddingLeft: 48 }}>{[0, 1, 2].map((i) => <span key={i} style={{ width: 9, height: 9, borderRadius: 99, background: C.brand, opacity: 0.3 + 0.7 * Math.abs(Math.sin((f + i * 6) / 6)) }} />)}</div>}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ================================================================= 5. end
const End: React.FC = () => {
  const f = useCurrentFrame();
  const stats = [['33', 'agent tools'], ['531k', 'test cases'], ['3', 'dependencies'], ['$0', 'to host']];
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 26, color: '#f4f2ec' }}>
      <div style={{ position: 'absolute', width: 900, height: 900, borderRadius: 999, background: `radial-gradient(circle, ${C.brand}40, transparent 65%)`, transform: `scale(${1 + 0.05 * Math.sin(f / 20)})` }} />
      <Rise><Logo size={110} /></Rise>
      <Rise at={6}><div style={{ fontFamily: SERIF, fontWeight: 700, letterSpacing: '-.035em', fontSize: 91, letterSpacing: '-.02em' }}>Agents that work <em style={GRAD_DARK}>like a team.</em></div></Rise>
      <div style={{ display: 'flex', gap: 60, marginTop: 10 }}>
        {stats.map(([n, l], i) => { const num = parseFloat(n.replace(/[^0-9.]/g, '')); const k = interpolate(f, [16 + i * 5, 50 + i * 5], [0, 1], { ...clamp, easing: ease }); const shown = n.replace(String(num), String(Math.round(num * k))); return <Rise key={l} at={16 + i * 5}><div style={{ textAlign: 'center' }}><div style={{ fontFamily: SERIF, fontWeight: 700, letterSpacing: '-.035em', fontSize: 52 }}>{shown}</div><div style={{ fontFamily: MONO, fontSize: 16, letterSpacing: '.14em', color: '#9a9ca3', textTransform: 'uppercase' }}>{l}</div></div></Rise>; })}
      </div>
      <Rise at={40}><div style={{ fontFamily: MONO, fontSize: 26, padding: '14px 30px', borderRadius: 999, border: '1px solid #ffffff22', background: '#ffffff0d', marginTop: 16 }}>github.com/Harshit-Makraria/<span style={{ color: C.brandDark }}>convorum</span></div></Rise>
      <Rise at={48}><div style={{ fontSize: 18, color: '#9a9ca3' }}>Open source · MIT · self-host free</div></Rise>
    </AbsoluteFill>
  );
};

// ================================================================= timeline
const SCENES: { C: React.FC; dur: number; bg?: string }[] = [
  { C: Intro, dur: 190 }, { C: Title, dur: 120 }, { C: What, dur: 175 }, { C: Connect, dur: 190 }, { C: Dashboard, dur: 1110 }, { C: OnCall, dur: 200 }, { C: End, dur: 160, bg: C.dark },
];
export const DURATION = SCENES.reduce((a, s) => a + s.dur, 0) - XFADE * (SCENES.length - 1);

export const Demo: React.FC = () => {
  let start = 0;
  return (
    <AbsoluteFill style={{ background: C.paper }}>
      {SCENES.map(({ C: S, dur, bg }, i) => {
        const from = start; start += dur - XFADE;
        return <Sequence key={i} from={from} durationInFrames={dur}><Scene dur={dur} bg={bg}><S /></Scene></Sequence>;
      })}
    </AbsoluteFill>
  );
};
