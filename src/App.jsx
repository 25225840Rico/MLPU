import { useState, useRef, useCallback, useEffect } from 'react'
import { analyzeProduct, fillAttributesWithAI } from './agents/orchestrator.js'
import FullscreenCamera from './FullscreenCamera.jsx'
import CropScreen from './CropScreen.jsx'

const ML = 'https://api.mercadolibre.com'
const DEBUG = false
const log = (...a) => { if (DEBUG) console.log(...a) }

const S = {
  ONBOARDING: 'onboarding', CAMERA: 'camera', CROP: 'crop', PREVIEW: 'preview',
  ANALYZING: 'analyzing', CATEGORIES: 'categories',
  CONFIRM: 'confirm', PUBLISHING: 'publishing', SUCCESS: 'success',
  HISTORY: 'history', DRAFTS: 'drafts'
}

// ── SOUND (metálico con WaveShaper)
function playBeep(type = 'capture', enabled = true) {
  if (!enabled) return
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const now = ctx.currentTime
    const makeDistortion = (amount = 150) => {
      const ws = ctx.createWaveShaper()
      const n = 256, curve = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1
        curve[i] = (Math.PI + amount) * x / (Math.PI + amount * Math.abs(x))
      }
      ws.curve = curve; return ws
    }
    if (type === 'capture') {
      const osc1 = ctx.createOscillator(), osc2 = ctx.createOscillator()
      const gain = ctx.createGain(), dist = makeDistortion(150)
      osc1.type = 'square'; osc1.frequency.value = 1400
      osc2.type = 'sawtooth'; osc2.frequency.value = 2100
      osc1.connect(dist); osc2.connect(dist); dist.connect(gain); gain.connect(ctx.destination)
      gain.gain.setValueAtTime(0, now)
      gain.gain.linearRampToValueAtTime(0.65, now + 0.005)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14)
      osc1.start(now); osc1.stop(now + 0.15)
      osc2.start(now); osc2.stop(now + 0.15)
    } else if (type === 'success') {
      [[1200, 0, 0.12], [1800, 0.14, 0.18]].forEach(([freq, delay, dur]) => {
        const osc = ctx.createOscillator(), g = ctx.createGain(), d = makeDistortion(100)
        osc.type = 'square'; osc.frequency.value = freq
        osc.connect(d); d.connect(g); g.connect(ctx.destination)
        g.gain.setValueAtTime(0, now + delay)
        g.gain.linearRampToValueAtTime(0.7, now + delay + 0.008)
        g.gain.exponentialRampToValueAtTime(0.001, now + delay + dur)
        osc.start(now + delay); osc.stop(now + delay + dur + 0.05)
      })
    }
  } catch (_) {}
}

// ── HISTORY
const HIST_KEY = 'mlpu_historial'
function saveToHistory(entry) {
  try {
    const h = JSON.parse(localStorage.getItem(HIST_KEY) || '[]')
    h.unshift(entry); if (h.length > 50) h.length = 50
    localStorage.setItem(HIST_KEY, JSON.stringify(h))
  } catch {}
}
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]') } catch { return [] }
}

// ── DRAFTS
const DRAFTS_KEY = 'mlpu_drafts'

async function compressForDraft(b64) {
  return compressToThumb(b64, 480)
}

function saveDraft(draft) {
  try {
    const all = loadDrafts()
    const idx = all.findIndex(d => d.id === draft.id)
    if (idx >= 0) all[idx] = draft; else all.unshift(draft)
    if (all.length > 50) all.length = 50
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(all))
  } catch {}
}
function loadDrafts() {
  try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) || '[]') } catch { return [] }
}
function deleteDraft(id) {
  try {
    const all = loadDrafts().filter(d => d.id !== id)
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(all))
  } catch {}
}
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

// ── SHARPNESS (varianza del Laplaciano sobre frame reducido)
function measureSharpness(video, canvas) {
  try {
    const W = 160, H = 120
    canvas.width = W; canvas.height = H
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, W, H)
    const d = ctx.getImageData(0, 0, W, H).data
    const gray = (r, c) => { const i = (r * W + c) * 4; return d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114 }
    let sum = 0
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const lap = gray(y,x)*4 - gray(y-1,x) - gray(y+1,x) - gray(y,x-1) - gray(y,x+1)
        sum += lap * lap
      }
    return sum / ((W - 2) * (H - 2))
  } catch { return 0 }
}

// ── THUMBNAIL para historial (con fix para mobile)
async function compressToThumb(b64, maxW = 120) {
  if (!b64) return ''
  return new Promise(resolve => {
    try {
      const img = new Image()
      const timeout = setTimeout(() => resolve(''), 3000)
      img.onload = () => {
        clearTimeout(timeout)
        try {
          const scale = Math.min(1, maxW / Math.max(img.width, img.height, 1))
          const c = document.createElement('canvas')
          c.width = Math.round(img.width * scale) || maxW
          c.height = Math.round(img.height * scale) || maxW
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
          resolve(c.toDataURL('image/jpeg', 0.75).split(',')[1])
        } catch { resolve('') }
      }
      img.onerror = () => { clearTimeout(timeout); resolve('') }
      img.src = 'data:image/jpeg;base64,' + b64
    } catch { resolve('') }
  })
}

async function cropSquareForML(b64, size = 1200) {
  return new Promise(res => {
    const img = new Image()
    const to = setTimeout(() => res(b64), 3000)
    img.onload = () => {
      clearTimeout(to)
      try {
        const side = Math.min(img.width, img.height)
        const c = document.createElement('canvas')
        c.width = size; c.height = size
        const ctx = c.getContext('2d')
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, size, size)
        const sx = (img.width - side) / 2, sy = (img.height - side) / 2
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size)
        res(c.toDataURL('image/jpeg', 0.88).split(',')[1])
      } catch { res(b64) }
    }
    img.onerror = () => { clearTimeout(to); res(b64) }
    img.src = 'data:image/jpeg;base64,' + b64
  })
}

const fmt = n => Number(n || 0).toLocaleString('es-CL')

const css = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#f5f7fe;--s1:#ffffff;--s2:#ffffff;--s3:#eef1fd;
  --brd:#dde3f7;--brd2:#c5ceee;
  --y:#f59e0b;--yb:#fffbeb;--g:#059669;--r:#dc2626;--b:#2563eb;--bb:#eff6ff;
  --txt:#0f172a;--dim:#64748b;--mono:'JetBrains Mono',monospace;
}
body{background:var(--bg);color:var(--txt);font-family:'Space Grotesk',sans-serif;min-height:100dvh;overscroll-behavior:none}
.app{max-width:430px;margin:0 auto;padding:16px 14px max(80px,calc(60px + env(safe-area-inset-bottom)));display:flex;flex-direction:column;gap:16px}
.top{display:flex;align-items:center;gap:8px;padding-bottom:14px;border-bottom:1px solid var(--brd)}
.logo{background:var(--y);color:#000;font-size:9px;font-weight:800;letter-spacing:2px;padding:4px 8px;border-radius:5px}
.top h1{font-size:16px;font-weight:700;flex:1}.top h1 em{color:var(--b);font-style:normal}
.cnt{font-size:11px;font-family:var(--mono);color:var(--b);background:var(--bb);border:1px solid var(--brd);border-radius:20px;padding:3px 9px}
.card{background:#fff;box-shadow:0 1px 4px rgba(30,40,120,.07),0 0 0 1px var(--brd);border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:13px}
.card h2{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:var(--dim)}
.f{display:flex;flex-direction:column;gap:4px}
.f label,.lbl{font-size:10px;font-weight:700;color:var(--dim);text-transform:uppercase;letter-spacing:1.2px}
.f input,.f select,.f textarea,.ei{background:#fff;border:1px solid var(--brd);border-radius:9px;color:var(--txt);font-family:var(--mono);font-size:16px;padding:10px 12px;outline:none;width:100%;transition:border-color .15s;resize:vertical;-webkit-appearance:none;appearance:none}
.f input:focus,.f select:focus,.f textarea:focus,.ei:focus{border-color:var(--b)}
.f input::placeholder,.ei::placeholder{color:var(--dim);opacity:.6}
.f select option{background:#fff}
.note{font-size:11px;color:var(--dim);background:var(--s3);border:1px solid var(--brd);border-radius:8px;padding:10px 13px;line-height:1.8}
.note code{color:var(--g);font-family:var(--mono);font-size:10px;word-break:break-all}
.btn{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:14px;border:none;border-radius:12px;cursor:pointer;padding:13px 18px;transition:all .1s;display:inline-flex;align-items:center;justify-content:center;gap:7px;touch-action:manipulation;user-select:none;-webkit-user-select:none}
.btn:active{transform:scale(.96)}
.btn-y{background:var(--b);color:#fff;width:100%;font-size:15px;padding:15px}
.btn-y:hover{background:#1d4ed8}
.btn-y:disabled{background:var(--brd);color:var(--dim);cursor:not-allowed;transform:none}
.btn-d{background:#fff;color:var(--txt);border:1px solid var(--brd);flex:1}
.btn-d:hover{border-color:var(--brd2)}
.btn-sm{font-size:12px;padding:7px 13px;border-radius:8px}
.btn-r{background:rgba(220,38,38,.08);color:var(--r);border:1px solid rgba(220,38,38,.25);width:100%}
.btn-r:hover{background:rgba(220,38,38,.14)}
.row{display:flex;gap:10px}
.cam{position:relative;border-radius:20px;overflow:hidden;aspect-ratio:3/4;background:#000;border:2px solid var(--brd);transition:border-color .3s,box-shadow .3s;max-height:70svh}
.cam.searching{border-color:var(--r);box-shadow:0 0 0 2px rgba(220,38,38,.15)}
.cam.focused{border-color:var(--g);box-shadow:0 0 0 3px rgba(5,150,105,.2);animation:pulse-g .5s ease}
@keyframes pulse-g{0%{box-shadow:0 0 0 0 rgba(5,150,105,.4)}100%{box-shadow:0 0 0 12px rgba(5,150,105,0)}}
.cam.dragover{border-color:var(--b);background:rgba(37,99,235,.06)}
.cam video,.cam img{width:100%;height:100%;object-fit:cover;display:block}
.cam-idle{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--dim)}
.cam-idle span{font-size:48px}.cam-idle p{font-size:12px}
.corner{position:absolute;width:26px;height:26px;border-color:var(--b);border-style:solid;opacity:.6}
.corner.tl{top:14px;left:14px;border-width:2px 0 0 2px;border-radius:3px 0 0 0}
.corner.tr{top:14px;right:14px;border-width:2px 2px 0 0;border-radius:0 3px 0 0}
.corner.bl{bottom:14px;left:14px;border-width:0 0 2px 2px;border-radius:0 0 0 3px}
.corner.br{bottom:14px;right:14px;border-width:0 2px 2px 0;border-radius:0 0 3px 0}
.focus-lbl{position:absolute;top:12px;left:50%;transform:translateX(-50%);font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;white-space:nowrap;pointer-events:none}
.focus-lbl.ready{background:rgba(5,150,105,.9);color:#fff}
.focus-lbl.seeking{background:rgba(220,38,38,.85);color:#fff}
.shutter{width:70px;height:70px;border-radius:50%;background:var(--b);border:4px solid rgba(37,99,235,.2);cursor:pointer;box-shadow:0 0 0 2px var(--b);margin:0 auto;transition:transform .1s;display:flex;align-items:center;justify-content:center;touch-action:manipulation;user-select:none;-webkit-user-select:none}
.shutter:active{transform:scale(.88)}
.shutter-ring{width:86px;height:86px;border-radius:50%;border:1.5px solid rgba(37,99,235,.18);display:flex;align-items:center;justify-content:center;margin:0 auto}
.shutter-inner{width:30px;height:30px;border-radius:50%;background:#fff;pointer-events:none}
.cam-actions{display:flex;flex-direction:column;gap:12px;align-items:center}
.photo-strip{display:flex;gap:8px;overflow-x:auto;padding:4px 0;-webkit-overflow-scrolling:touch}
.photo-strip::-webkit-scrollbar{height:3px}.photo-strip::-webkit-scrollbar-thumb{background:var(--brd);border-radius:2px}
.pthumb{position:relative;flex-shrink:0;width:72px;height:72px;border-radius:10px;overflow:hidden;border:2px solid var(--brd);cursor:pointer;transition:border-color .15s;touch-action:manipulation;user-select:none;-webkit-user-select:none}
.pthumb.main{border-color:var(--b);box-shadow:0 0 0 1px var(--b)}
.pthumb img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
.pthumb .mb{position:absolute;bottom:2px;left:50%;transform:translateX(-50%);font-size:7px;font-weight:800;background:var(--b);color:#fff;padding:1px 4px;border-radius:4px;white-space:nowrap;pointer-events:none}
.pthumb .del{position:absolute;top:-2px;right:-2px;width:24px;height:24px;border-radius:50%;background:rgba(255,255,255,.95);color:var(--txt);font-size:12px;display:flex;align-items:center;justify-content:center;cursor:pointer;border:1.5px solid var(--brd);touch-action:manipulation}
.add-photo{flex-shrink:0;width:72px;height:72px;border-radius:10px;border:2px dashed var(--brd2);display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;color:var(--dim);font-size:9px;gap:4px;transition:border-color .15s;touch-action:manipulation;user-select:none;-webkit-user-select:none}
.add-photo:hover,.add-photo:active{border-color:var(--b);color:var(--b)}
.add-photo span{font-size:22px;pointer-events:none}
.loader{background:#fff;box-shadow:0 1px 4px rgba(30,40,120,.07),0 0 0 1px var(--brd);border-radius:18px;padding:36px 22px;display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center}
.ring{width:72px;height:72px;border-radius:50%;border:3px solid var(--brd2);border-top-color:var(--b);animation:spin .7s linear infinite}
.ring-sm{width:16px;height:16px;border-radius:50%;border:2px solid var(--brd2);border-top-color:var(--b);animation:spin .7s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.agents{display:flex;flex-direction:column;gap:7px;width:100%;margin-top:4px}
.agent{display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--s3);border-radius:9px;font-size:12px;color:var(--dim)}
.agent .dot{width:6px;height:6px;border-radius:50%;background:var(--b);animation:blink .9s infinite;flex-shrink:0}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.1}}
.progress-track{height:5px;background:var(--brd);border-radius:3px;overflow:hidden;width:100%}
.progress-fill{height:100%;background:var(--b);border-radius:3px;transition:width .4s ease}
.progress-fill.g{background:var(--g)}
.progress-fill.shimmer{width:100%;background:linear-gradient(90deg,var(--brd) 0%,var(--b) 40%,var(--brd) 100%);background-size:200% 100%;animation:shimmer 1.4s infinite}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.agent-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--brd)}
.agent-row:last-child{border-bottom:none}
.agent-lbl{font-size:12px;flex:1;color:var(--dim)}
.agent-lbl.done{color:var(--txt);font-weight:600}
.agent-bar{width:100px;flex-shrink:0}
.thumb{border-radius:14px;overflow:hidden;aspect-ratio:3/4;border:1px solid var(--brd)}
.thumb img{width:100%;height:100%;object-fit:cover}
.thumb-16{border-radius:14px;overflow:hidden;aspect-ratio:16/9;border:1px solid var(--brd)}
.thumb-16 img{width:100%;height:100%;object-fit:cover}
.thumb-sq{border-radius:14px;overflow:hidden;aspect-ratio:1/1;border:1px solid var(--brd)}
.thumb-sq img{width:100%;height:100%;object-fit:cover}
.cat-list{display:flex;flex-direction:column;gap:8px}
.cat-item{background:#fff;border:1px solid var(--brd);border-radius:13px;padding:13px 15px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;transition:all .12s;touch-action:manipulation;user-select:none;-webkit-user-select:none}
.cat-item:hover{border-color:var(--b);background:var(--bb)}
.cat-item.no-id{opacity:.6;cursor:not-allowed}
.cat-name{font-size:14px;font-weight:600}
.cat-id{font-size:11px;font-family:var(--mono);color:var(--dim);margin-top:2px}
.arrow{color:var(--b);font-size:16px}
.panel{background:#fff;box-shadow:0 1px 4px rgba(30,40,120,.07),0 0 0 1px var(--brd);border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.panel-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.8px;color:var(--dim)}
.listing-tabs{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}
.lt-tab{background:var(--s3);border:1px solid var(--brd);border-radius:9px;padding:8px 6px;cursor:pointer;text-align:center;transition:all .12s}
.lt-tab.active{border-color:var(--b);background:var(--bb)}
.lt-tab .lt-name{font-size:11px;font-weight:700}
.lt-tab .lt-fee{font-size:10px;font-family:var(--mono);color:var(--dim);margin-top:2px}
.lt-tab .lt-gain{font-size:10px;color:var(--g);margin-top:1px}
.profit-rows{display:flex;flex-direction:column;gap:5px}
.prow{display:flex;justify-content:space-between;align-items:center;font-size:13px}
.prow .pk{color:var(--dim)}
.prow .pv{font-family:var(--mono);font-size:12px}
.prow.total{border-top:1px solid var(--brd);padding-top:7px;margin-top:2px}
.prow.total .pk{font-weight:700;color:var(--txt)}
.prow.total .pv{font-size:15px;font-weight:700}
.comp-row{display:flex;justify-content:space-between;gap:6px}
.comp-item{flex:1;background:var(--s3);border-radius:8px;padding:8px;text-align:center}
.comp-item .cv{font-size:13px;font-weight:700;font-family:var(--mono)}
.comp-item .ck{font-size:9px;color:var(--dim);margin-top:2px;text-transform:uppercase;letter-spacing:1px}
.toggle-row{display:flex;align-items:center;justify-content:space-between;padding:9px 0}
.toggle-label{font-size:13px;font-weight:600}
.toggle-sub{font-size:11px;color:var(--dim);margin-top:1px}
.toggle{width:40px;height:22px;border-radius:11px;background:var(--brd2);cursor:pointer;position:relative;transition:background .15s;flex-shrink:0;border:none;touch-action:manipulation;user-select:none;-webkit-user-select:none}
.toggle.on{background:var(--b)}
.toggle::after{content:'';position:absolute;width:16px;height:16px;border-radius:50%;background:#fff;top:3px;left:3px;transition:left .15s}
.toggle.on::after{left:21px;background:#fff}
.attr-grid{display:flex;flex-direction:column;gap:8px}
.attr-item{display:flex;flex-direction:column;gap:3px}
.attr-name{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--dim)}
.attr-missing{border-color:var(--r) !important}
.cat-strip{display:flex;align-items:center;justify-content:space-between;background:var(--s3);border:1px solid var(--brd);border-radius:9px;padding:10px 13px}
.change{font-size:12px;color:var(--dim);cursor:pointer;text-decoration:underline}
.change:hover{color:var(--b)}
.success{background:#fff;border:1px solid var(--g);border-radius:18px;padding:32px 22px;display:flex;flex-direction:column;align-items:center;gap:13px;text-align:center}
.ok{font-size:52px}
.pub-link{font-family:var(--mono);font-size:11px;color:var(--b);word-break:break-all;background:var(--s3);border-radius:8px;padding:10px 13px;width:100%;text-align:left}
.pub-link a{color:inherit}
.err{background:rgba(220,38,38,.06);border:1px solid rgba(220,38,38,.25);border-radius:10px;padding:11px 14px;font-size:12px;color:var(--r);display:flex;gap:8px;align-items:flex-start;word-break:break-word}
.ok-msg{background:rgba(5,150,105,.08);border:1px solid rgba(5,150,105,.25);border-radius:10px;padding:11px 14px;font-size:12px;color:var(--g);display:flex;gap:8px;align-items:flex-start}
.warn{background:var(--yb);border:1px solid rgba(245,158,11,.25);border-radius:10px;padding:10px 13px;font-size:12px;color:var(--y)}
hr{border:none;border-top:1px solid var(--brd)}
::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:var(--brd);border-radius:2px}
.hist-list{display:flex;flex-direction:column;gap:10px}
.hist-item{display:flex;gap:12px;align-items:center;background:#fff;border:1px solid var(--brd);border-radius:13px;padding:11px 13px;cursor:pointer;transition:border-color .12s}
.hist-item:hover{border-color:var(--b)}
.hist-thumb{width:56px;height:56px;border-radius:9px;overflow:hidden;flex-shrink:0;background:var(--s3);border:1px solid var(--brd);display:flex;align-items:center;justify-content:center}
.hist-thumb img{width:100%;height:100%;object-fit:cover}
.hist-info{flex:1;min-width:0}
.hist-title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hist-meta{font-size:11px;color:var(--dim);margin-top:2px;line-height:1.5}
.hist-gain{font-size:12px;font-weight:700;color:var(--g);font-family:var(--mono)}
.empty-hist{text-align:center;padding:40px 20px;color:var(--dim);font-size:13px;background:#fff;border-radius:16px;border:1px solid var(--brd);line-height:2}
`

const LS = {
  get: k => { try { return localStorage.getItem(k) || '' } catch { return '' } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch {} }
}

function PhotoStrip({ imgs, onReorder, onDelete, onAdd, showAdd = true }) {
  return (
    <div className="photo-strip">
      {imgs.map((b64, i) => (
        <div key={i} className={`pthumb${i === 0 ? ' main' : ''}`} onClick={() => i !== 0 && onReorder(i)}>
          <img src={`data:image/jpeg;base64,${b64}`} alt="" />
          {i === 0 && <div className="mb">PRINCIPAL</div>}
          <div className="del" onClick={e => { e.stopPropagation(); onDelete(i) }}>✕</div>
        </div>
      ))}
      {showAdd && imgs.length < 8 && (
        <div className="add-photo" onClick={onAdd}><span>+</span><div>Agregar</div></div>
      )}
    </div>
  )
}

export default function App() {
  const [screen,      setScreen]      = useState(S.ONBOARDING)
  const [appId,       setAppId]       = useState(() => LS.get('ml_app_id')    || '3829359465845583')
  const [anthKey,     setAnthKey]     = useState(() => LS.get('anthropic_key') || '')
  const [anthDraft,   setAnthDraft]   = useState(() => LS.get('anthropic_key') || '')
  const [proxyUrl,    setProxyUrl]    = useState(() => LS.get('proxy_url')     || 'https://mlpu-proxy.aronricocl.workers.dev')
  const [proxyDraft,  setProxyDraft]  = useState(() => LS.get('proxy_url')     || 'https://mlpu-proxy.aronricocl.workers.dev')
  const [soundOn,       setSoundOn]       = useState(() => LS.get('sound_on') !== 'false')
  // ── Sesión ML centralizada en el Worker (KV). El front ya no guarda tokens.
  const [authStatus,   setAuthStatus]   = useState(null) // { active, secs_left, expires_at } | null
  const [authCode,      setAuthCode]      = useState('')
  const [exchanging,    setExchanging]    = useState(false)
  const [authErr,       setAuthErr]       = useState('')

  const mlBase = useCallback(path => {
    if (proxyUrl) return `${proxyUrl.replace(/\/$/, '')}/ml${path}`
    return `${ML}${path}`
  }, [proxyUrl])

  const beep = useCallback((type = 'capture') => playBeep(type, soundOn), [soundOn])

  // ── SESIÓN ML (gestionada por el Worker). El front solo consulta estado.
  const sessionActive = !!authStatus?.active
  const sessionSecsLeft = authStatus?.active ? (authStatus.secs_left ?? null) : null
  const fmtTokenTime = s => {
    if (s === null || s === undefined) return null
    if (s <= 0) return 'Expirado'
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  }
  const tokenColor = sessionSecsLeft === null ? null
    : sessionSecsLeft <= 0 ? 'var(--r)'
    : sessionSecsLeft < 1800 ? 'var(--r)'
    : sessionSecsLeft < 7200 ? 'var(--y)'
    : 'var(--g)'

  // ── Consultar estado de sesión al Worker (KV)
  const fetchAuthStatus = useCallback(async () => {
    try {
      const r = await fetch(mlBase('/auth/status'), { headers: { Accept: 'application/json' } })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setAuthStatus(data)
      return data
    } catch (e) {
      log('[auth] status fail:', e.message)
      setAuthStatus({ active: false, secs_left: 0 })
      return null
    }
  }, [mlBase])

  // ── Sembrar sesión: enviar el código OAuth al Worker (que guarda en KV)
  const initAuth = useCallback(async () => {
    if (!authCode.trim()) return
    setExchanging(true); setAuthErr('')
    try {
      // Acepta URL completa de httpbin o el código pelado.
      let code = authCode.trim()
      try { code = new URL(code).searchParams.get('code') || code } catch {}
      const r = await fetch(mlBase('/auth/init'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ code, redirect_uri: 'https://httpbin.org/get' })
      })
      const data = await r.json()
      if (!r.ok || !data.ok) throw new Error(data.error || data.message || `HTTP ${r.status}`)
      setAuthCode('')
      await fetchAuthStatus()
    } catch (e) {
      setAuthErr('Error al activar la sesión: ' + e.message)
    } finally {
      setExchanging(false)
    }
  }, [authCode, mlBase, fetchAuthStatus])

  // Estado inicial + poll cada 60s para reflejar la sesión del Worker.
  useEffect(() => {
    fetchAuthStatus()
    const id = setInterval(fetchAuthStatus, 60_000)
    return () => clearInterval(id)
  }, [fetchAuthStatus])

  const videoRef     = useRef(null)
  const canvasRef    = useRef(null)
  const smallCanvas  = useRef(null)
  const fileRef      = useRef(null)
  const commTimer    = useRef(null)
  const sharpTimer   = useRef(null)
  const focusCount   = useRef(0)
  const autoCaptured = useRef(false)
  const captureRef   = useRef(null) // stable ref to latest capture fn

  const [showFsCam,   setShowFsCam]   = useState(false)
  const [stream,      setStream]      = useState(null)
  const [imgs,        setImgs]        = useState([])
  const [analysis,    setAnalysis]    = useState(null)
  const [cats,        setCats]        = useState([])
  const [selCat,      setSelCat]      = useState(null)
  const [result,      setResult]      = useState(null)
  const [err,         setErr]         = useState(null)
  const [count,       setCount]       = useState(0)
  const [autoCapture, setAutoCapture] = useState(false)
  const [borderState, setBorderState] = useState('neutral')
  const [historial,   setHistorial]   = useState(() => loadHistory())
  const [dragOver,    setDragOver]    = useState(false)

  // ── CONFIRM
  const [editTitle,      setEditTitle]      = useState('')
  const [editPrice,      setEditPrice]      = useState(0)
  const [editDesc,       setEditDesc]       = useState('')
  const [editCondition,  setEditCondition]  = useState('used')
  const [editQty,        setEditQty]        = useState(3)
  const [listingType,    setListingType]    = useState('free')
  const [requiredAttrs,  setRequiredAttrs]  = useState([])
  const [attrValues,     setAttrValues]     = useState({})
  const [loadingAttrs,   setLoadingAttrs]   = useState(false)
  const [missingAttrIds, setMissingAttrIds] = useState([])
  const [commissions,    setCommissions]    = useState(null)
  const [loadingComm,    setLoadingComm]    = useState(false)
  const [compPrices,     setCompPrices]     = useState(null)
  const [freeShipping,   setFreeShipping]   = useState(false)
  const [localPickup,    setLocalPickup]    = useState(false)
  const [shippingCost,   setShippingCost]   = useState(3000)
  const [productCost,    setProductCost]    = useState(0)

  // ── ANALYZING progress
  const [analysisDone,   setAnalysisDone]   = useState(false)

  // ── PUBLISHING progress
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 1 })

  // ── DRAFTS
  const [drafts,         setDrafts]         = useState(() => loadDrafts())
  const [selectedDrafts, setSelectedDrafts] = useState(new Set())
  const [batchProgress,  setBatchProgress]  = useState(null) // {current,total,title}
  const [currentDraftId, setCurrentDraftId] = useState(null)
  const [savingDraft,    setSavingDraft]    = useState(false)

  // ── CAMERA
  const stopCam = useCallback(() => {
    if (stream) { stream.getTracks().forEach(t => t.stop()); setStream(null) }
    clearInterval(sharpTimer.current)
    setBorderState('neutral'); focusCount.current = 0; autoCaptured.current = false
  }, [stream])

  const startCam = useCallback(async () => {
    setErr(null)
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', height: { ideal: 1920 }, aspectRatio: { ideal: 3/4 } }
      })
      try {
        const track = s.getVideoTracks()[0]
        const caps = track?.getCapabilities?.()
        if (caps?.focusMode?.includes('continuous'))
          await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] })
      } catch (_) {}
      setStream(s); setScreen(S.CAMERA)
      setTimeout(() => { if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.play() } }, 80)
    } catch (e) { setErr('Cámara no disponible: ' + e.message) }
  }, [])

  const addImgs = useCallback((newImgs) => {
    setImgs(prev => {
      const available = 8 - prev.length
      return [...prev, ...newImgs.slice(0, available)]
    })
  }, [])

  const capture = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return
    const v = videoRef.current, c = canvasRef.current
    c.width = v.videoWidth || 960; c.height = v.videoHeight || 1280
    c.getContext('2d').drawImage(v, 0, 0)
    const b64 = c.toDataURL('image/jpeg', 0.92).split(',')[1]
    addImgs([b64])
    beep('capture')
    stopCam()
    setScreen(S.CROP)
  }, [stopCam, addImgs, beep])

  // Keep captureRef current so auto-capture always calls latest version
  useEffect(() => { captureRef.current = capture }, [capture])

  const handleFiles = useCallback((files) => {
    const list = Array.from(files).filter(f => f.type.startsWith('image/')).slice(0, 8)
    if (!list.length) return
    // Use index-based array to preserve file selection order across async callbacks
    const loaded = new Array(list.length)
    let done = 0
    list.forEach((f, idx) => {
      const r = new FileReader()
      r.onload = ev => {
        loaded[idx] = ev.target.result.split(',')[1]
        if (++done === list.length) {
          addImgs(loaded.filter(Boolean))
          stopCam()
          setScreen(S.CROP)
          if (fileRef.current) fileRef.current.value = ''
        }
      }
      r.onerror = () => { if (++done === list.length && loaded.some(Boolean)) { addImgs(loaded.filter(Boolean)); stopCam(); setScreen(S.CROP) } }
      r.readAsDataURL(f)
    })
  }, [addImgs, stopCam])

  // Drag & drop
  const onDragOver  = useCallback(e => { e.preventDefault(); setDragOver(true) }, [])
  const onDragLeave = useCallback(() => setDragOver(false), [])
  const onDrop      = useCallback(e => {
    e.preventDefault(); setDragOver(false)
    handleFiles([...e.dataTransfer.files])
  }, [handleFiles])

  // Stable callbacks for PhotoStrip (avoids inline arrow fn on each render)
  const onReorderImg = useCallback(i => setImgs(prev => [prev[i], ...prev.filter((_, j) => j !== i)]), [])
  const onDeleteImg  = useCallback(i => setImgs(prev => prev.filter((_, j) => j !== i)), [])
  const onAddPhoto   = useCallback(() => fileRef.current?.click(), [])

  const onFsPhotoCaptured = useCallback((dataURL) => {
    const b64 = dataURL.split(',')[1]
    setImgs(prev => { const slots = 8 - prev.length; return slots > 0 ? [...prev, b64] : prev })
    setShowFsCam(false)
    setScreen(S.CROP)
  }, [])

  // ── AUTO-CAPTURE sharpness loop
  useEffect(() => {
    if (!autoCapture || !stream || screen !== S.CAMERA) {
      clearInterval(sharpTimer.current)
      return
    }
    const THRESHOLD = 300, FRAMES = 3
    setBorderState('searching')
    sharpTimer.current = setInterval(() => {
      if (!videoRef.current || !smallCanvas.current) return
      const score = measureSharpness(videoRef.current, smallCanvas.current)
      log('[sharp]', Math.round(score))
      if (score > THRESHOLD) {
        focusCount.current++
        if (focusCount.current >= FRAMES) {
          setBorderState('focused')
          if (!autoCaptured.current) {
            autoCaptured.current = true
            clearInterval(sharpTimer.current)
            setTimeout(() => { captureRef.current?.(); autoCaptured.current = false; focusCount.current = 0 }, 1200)
          }
        }
      } else {
        focusCount.current = Math.max(0, focusCount.current - 1)
        if (focusCount.current === 0) setBorderState('searching')
      }
    }, 300)
    return () => clearInterval(sharpTimer.current)
  }, [autoCapture, stream, screen])

  // ── ANALYZE
  const analyze = useCallback(async () => {
    if (!imgs.length) return
    setErr(null); setAnalysisDone(false); setScreen(S.ANALYZING)
    try {
      const a = await analyzeProduct(imgs[0], anthKey)
      setAnalysis(a)
      setAnalysisDone(true)
      const found = [], seen = new Set()
      for (const q of (a.categorySearches || []).slice(0, 3)) {
        try {
          const res  = await fetch(`${ML}/sites/MLC/domain_discovery/search?q=${encodeURIComponent(q)}`)
          const data = await res.json()
          const items = Array.isArray(data) ? data : [data]
          for (const c of items.slice(0, 2)) {
            if (c?.category_id && !seen.has(c.category_id)) {
              seen.add(c.category_id)
              found.push({ id: c.category_id, name: c.category_name || q })
            }
          }
        } catch (_) {}
      }
      if (!found.length)
        (a.categorySearches || []).forEach(n => found.push({ id: '', name: n, manual: true }))
      setCats(found.slice(0, 5))
      beep('capture')
      setScreen(S.CATEGORIES)
    } catch (e) { setErr('Error IA: ' + e.message); setScreen(S.PREVIEW) }
  }, [imgs, anthKey, beep])

  // ── SELECT CATEGORY
  const selectCategory = useCallback(cat => {
    if (!cat.id) { setErr('Categoría sin ID válido.'); return }
    setErr(null); setSelCat(cat)
    setEditTitle(analysis?.title || ''); setEditPrice(analysis?.price || 0)
    setEditDesc(analysis?.description || ''); setEditCondition(analysis?.condition || 'used')
    setEditQty(3); setListingType('free')
    setRequiredAttrs([]); setAttrValues({}); setMissingAttrIds([])
    setCommissions(null); setCompPrices(null); setFreeShipping(false); setLocalPickup(false)
    setScreen(S.CONFIRM)
  }, [analysis])

  // ── FETCH ATTRS + COMP PRICES on CONFIRM
  useEffect(() => {
    if (screen !== S.CONFIRM || !selCat?.id) return
    let cancelled = false
    ;(async () => {
      setLoadingAttrs(true)
      try {
        const r = await fetch(mlBase(`/categories/${selCat.id}/attributes`))
        if (cancelled) return
        const data = await r.json()
        const needed = (Array.isArray(data) ? data : []).filter(a => a.tags?.required && !a.tags?.fixed)
        log('[attrs]', needed.map(a => a.id))
        if (!cancelled) setRequiredAttrs(needed)
        if (needed.length && anthKey && !cancelled) {
          const filled = await fillAttributesWithAI(needed, analysis, anthKey, { title: editTitle, description: editDesc, categoryName: selCat?.name })
          if (!cancelled) setAttrValues(filled)
        }
      } catch (e) { log('[attrs]', e.message) }
      finally { if (!cancelled) setLoadingAttrs(false) }
    })()
    ;(async () => {
      try {
        const r = await fetch(`${ML}/sites/MLC/search?category=${selCat.id}&q=${encodeURIComponent(analysis?.title || '')}&limit=20`)
        if (cancelled) return
        const data = await r.json()
        const prices = (data.results || []).map(i => i.price).filter(p => p > 0).sort((a, b) => a - b)
        if (prices.length && !cancelled) {
          const mid = Math.floor(prices.length / 2)
          setCompPrices({
            min: prices[0], max: prices[prices.length - 1],
            avg: Math.round(prices.reduce((s, p) => s + p, 0) / prices.length),
            median: prices.length % 2 ? prices[mid] : Math.round((prices[mid-1] + prices[mid]) / 2),
            count: prices.length
          })
        }
      } catch (e) { log('[comp-prices]', e.message) }
    })()
    return () => { cancelled = true }
  }, [screen, selCat?.id, mlBase])

  // ── COMMISSIONS debounced
  useEffect(() => {
    if (screen !== S.CONFIRM || !selCat?.id || !editPrice) return
    if (commTimer.current) clearTimeout(commTimer.current)
    commTimer.current = setTimeout(async () => {
      setLoadingComm(true)
      try {
        const types = ['free', 'gold_special', 'gold_pro']
        const results = await Promise.allSettled(types.map(async type => {
          const url = mlBase(`/sites/MLC/listing_prices?price=${editPrice}&listing_type_id=${type}&category_id=${selCat.id}`)
          const r = await fetch(url)
          if (!r.ok) return null
          const data = await r.json()
          const arr = Array.isArray(data) ? data : [data]
          const item = arr.find(d => d.listing_type_id === type) || arr[0]
          if (!item) return null
          return { type, fee: item.sale_fee_amount || 0, pct: item.sale_fee_details?.percentage_fee || 0 }
        }))
        const comm = {}
        results.forEach(r => { if (r.status === 'fulfilled' && r.value) comm[r.value.type] = r.value })
        setCommissions(Object.keys(comm).length ? comm : null)
      } catch (e) { log('[comm]', e.message); setCommissions(null) }
      finally { setLoadingComm(false) }
    }, 500)
  }, [editPrice, listingType, screen, selCat?.id, mlBase])

  // ── PROFIT
  const currentFee     = commissions?.[listingType]?.fee || 0
  const shippingDeduct = freeShipping ? shippingCost : 0
  const profit         = editPrice - currentFee - shippingDeduct - productCost
  const margin         = editPrice > 0 ? Math.round((profit / editPrice) * 100) : 0

  // ── PUBLISH
  const publish = useCallback(async () => {
    if (!selCat?.id || !analysis) return
    const missing = requiredAttrs.filter(a => !attrValues[a.id]?.toString().trim())
    if (missing.length) {
      setMissingAttrIds(missing.map(a => a.id))
      setErr('Faltan atributos requeridos: ' + missing.map(a => a.name).join(', '))
      return
    }
    setScreen(S.PUBLISHING); setErr(null)
    setUploadProgress({ current: 0, total: imgs.length })
    try {
      const pictures = []
      for (let i = 0; i < imgs.length; i++) {
        const imgB64 = await cropSquareForML(imgs[i])
        try {
          const blob = await (await fetch(`data:image/jpeg;base64,${imgB64}`)).blob()
          const form = new FormData(); form.append('file', blob, 'product.jpg')
          const pr = await fetch(mlBase('/pictures/items/upload'), {
            method: 'POST', body: form
          })
          if (pr.ok) { const pd = await pr.json(); pictures.push({ id: pd.id }) }
          else log('[publish] img fail:', pr.status)
        } catch (e) { log('[publish] img err:', e.message) }
        setUploadProgress({ current: i + 1, total: imgs.length })
      }
      const attributes = Object.entries(attrValues)
        .filter(([, v]) => v?.toString().trim())
        .map(([id, value_name]) => ({ id, value_name: value_name.toString() }))
      const payload = {
        title:              editTitle.slice(0, 60),
        category_id:        selCat.id,
        price:              editPrice,
        currency_id:        'CLP',
        available_quantity: editQty,
        buying_mode:        'buy_it_now',
        condition:          editCondition,
        listing_type_id:    listingType,
        description:        { plain_text: editDesc || editTitle },
        ...(pictures.length  && { pictures }),
        ...(attributes.length && { attributes }),
        shipping: freeShipping
          ? { mode: 'me2', free_methods: [], free_shipping: true,  local_pick_up: localPickup }
          : { mode: 'me2',                   free_shipping: false, local_pick_up: localPickup },
        sale_terms: [
          { id: 'WARRANTY_TYPE', value_name: 'Garantía del vendedor' },
          { id: 'WARRANTY_TIME',  value_name: '30 días' }
        ]
      }
      const r = await fetch(mlBase('/items'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const data = await r.json()
      if (!r.ok) {
        const mc = (data.cause || []).find(c =>
          c.code === 'item.attributes.missing_required' || c.message?.includes('missing_required'))
        if (mc) {
          const refs = mc.references || []
          setMissingAttrIds(refs)
          const names = refs.map(id => requiredAttrs.find(a => a.id === id)?.name || id)
          throw new Error(`Atributos obligatorios faltantes: ${names.join(', ')}. Completa los campos resaltados.`)
        }
        const causes = (data.cause || []).map(c => c.message || c.code || JSON.stringify(c)).join(' | ')
        throw new Error(`${data.message}${causes ? ': ' + causes : ''}`)
      }
      // Save history (in separate try/catch so thumbnail failure doesn't block save)
      try {
        const thumb = await compressToThumb(imgs[0] || '')
        const profitNow = editPrice - currentFee - shippingDeduct - productCost
        saveToHistory({ id: data.id, title: editTitle, price: editPrice,
          thumbnail: thumb, permalink: data.permalink || '',
          fecha: new Date().toISOString(), category_name: selCat.name, ganancia_neta: profitNow })
        setHistorial(loadHistory())
      } catch {}
      setResult(data); setCount(c => c + 1); beep('success'); setScreen(S.SUCCESS)
    } catch (e) { setErr('Error publicando: ' + e.message); setScreen(S.CONFIRM) }
  }, [selCat, analysis, imgs, mlBase, editTitle, editPrice, editDesc, editCondition,
      editQty, listingType, requiredAttrs, attrValues, freeShipping, localPickup,
      currentFee, shippingDeduct, productCost, beep])

  // ── SAVE DRAFT
  const saveCurrentDraft = useCallback(async () => {
    setSavingDraft(true)
    try {
      const thumb = await compressToThumb(imgs[0] || '')
      const compImgs = await Promise.all(imgs.map(b => compressForDraft(b)))
      const id = currentDraftId || genId()
      saveDraft({
        id, created: new Date().toISOString(), thumb,
        imgs: compImgs, analysis, selCat,
        editTitle, editPrice, editDesc, editCondition, editQty,
        listingType, attrValues, requiredAttrs,
        freeShipping, localPickup, shippingCost, productCost
      })
      setCurrentDraftId(id)
      setDrafts(loadDrafts())
      setErr('✓ Borrador guardado')
      setTimeout(() => setErr(null), 2000)
    } catch (e) {
      setErr('Error al guardar borrador: ' + e.message)
    } finally {
      setSavingDraft(false)
    }
  }, [imgs, analysis, selCat, editTitle, editPrice, editDesc, editCondition, editQty,
      listingType, attrValues, requiredAttrs, freeShipping, localPickup, shippingCost, productCost, currentDraftId])

  // ── LOAD DRAFT TO CONFIRM
  const loadDraftToConfirm = useCallback((draft) => {
    setImgs(draft.imgs || [])
    setAnalysis(draft.analysis)
    setSelCat(draft.selCat)
    setEditTitle(draft.editTitle || '')
    setEditPrice(draft.editPrice || 0)
    setEditDesc(draft.editDesc || '')
    setEditCondition(draft.editCondition || 'used')
    setEditQty(draft.editQty || 1)
    setListingType(draft.listingType || 'free')
    setAttrValues(draft.attrValues || {})
    setRequiredAttrs(draft.requiredAttrs || [])
    setFreeShipping(draft.freeShipping || false)
    setLocalPickup(draft.localPickup || false)
    setShippingCost(draft.shippingCost || 3000)
    setProductCost(draft.productCost || 0)
    setMissingAttrIds([])
    setCommissions(null); setCompPrices(null)
    setCurrentDraftId(draft.id)
    setScreen(S.CONFIRM)
  }, [])

  // ── PUBLISH BATCH
  const publishBatch = useCallback(async () => {
    const toPublish = drafts.filter(d => selectedDrafts.has(d.id))
    if (!toPublish.length) return
    setBatchProgress({ current: 0, total: toPublish.length, title: '' })
    let published = 0
    const errors = []

    for (let i = 0; i < toPublish.length; i++) {
      const draft = toPublish[i]
      setBatchProgress({ current: i, total: toPublish.length, title: draft.editTitle })
      try {
        // subir fotos
        const pictures = []
        for (const rawB64 of (draft.imgs || [])) {
          const imgB64 = await cropSquareForML(rawB64)
          try {
            const blob = await (await fetch(`data:image/jpeg;base64,${imgB64}`)).blob()
            const form = new FormData(); form.append('file', blob, 'product.jpg')
            const pr = await fetch(mlBase('/pictures/items/upload'), {
              method: 'POST', body: form
            })
            if (pr.ok) { const pd = await pr.json(); pictures.push({ id: pd.id }) }
          } catch {}
        }
        const attributes = Object.entries(draft.attrValues || {})
          .filter(([, v]) => v?.toString().trim())
          .map(([id, value_name]) => ({ id, value_name: value_name.toString() }))
        const payload = {
          title: (draft.editTitle || '').slice(0, 60),
          category_id: draft.selCat.id,
          price: draft.editPrice,
          currency_id: 'CLP',
          available_quantity: draft.editQty || 1,
          buying_mode: 'buy_it_now',
          condition: draft.editCondition || 'used',
          listing_type_id: draft.listingType || 'free',
          description: { plain_text: draft.editDesc || draft.editTitle || '' },
          ...(pictures.length && { pictures }),
          ...(attributes.length && { attributes }),
          shipping: draft.freeShipping
            ? { mode: 'me2', free_methods: [], free_shipping: true, local_pick_up: draft.localPickup || false }
            : { mode: 'me2', free_shipping: false, local_pick_up: draft.localPickup || false },
          sale_terms: [
            { id: 'WARRANTY_TYPE', value_name: 'Garantía del vendedor' },
            { id: 'WARRANTY_TIME', value_name: '30 días' }
          ]
        }
        const r = await fetch(mlBase('/items'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        const data = await r.json()
        if (!r.ok) throw new Error(data.message || 'Error')
        // guardar en historial
        try {
          const thumb = await compressToThumb(draft.imgs?.[0] || '')
          saveToHistory({ id: data.id, title: draft.editTitle, price: draft.editPrice,
            thumbnail: thumb, permalink: data.permalink || '',
            fecha: new Date().toISOString(), category_name: draft.selCat?.name || '',
            ganancia_neta: draft.editPrice - (draft.productCost || 0) })
        } catch {}
        deleteDraft(draft.id)
        published++
      } catch (e) {
        errors.push(draft.editTitle + ': ' + e.message)
      }
    }

    setDrafts(loadDrafts())
    setHistorial(loadHistory())
    setSelectedDrafts(new Set())
    setBatchProgress(null)
    setCount(c => c + published)

    if (published > 0) {
      beep('success')
      if (errors.length) {
        setErr(`${published} publicados. Errores: ${errors.join(' | ')}`)
      }
    } else if (errors.length) {
      setErr('No se pudo publicar: ' + errors.join(' | '))
    }
  }, [drafts, selectedDrafts, mlBase, beep])

  const reset = () => {
    setImgs([]); setAnalysis(null); setCats([]); setSelCat(null)
    setResult(null); setErr(null); setRequiredAttrs([]); setAttrValues({})
    setMissingAttrIds([]); setCommissions(null); setCompPrices(null)
    setCurrentDraftId(null)
    setScreen(S.CAMERA)
  }

  useEffect(() => () => { stopCam(); clearInterval(sharpTimer.current); clearTimeout(commTimer.current) }, [])

  const LT_LABELS = { free: 'Gratuita', gold_special: 'Clásica', gold_pro: 'Premium' }
  const camClass = `cam${borderState === 'focused' ? ' focused' : borderState === 'searching' ? ' searching' : ''}${dragOver ? ' dragover' : ''}`

  // Helper for error/ok message rendering
  const ErrMsg = ({ e }) => {
    if (!e) return null
    if (e.startsWith('✓'))
      return <div className="ok-msg"><span>✓</span><span>{e.slice(2)}</span></div>
    return <div className="err"><span>⚠</span><span>{e}</span></div>
  }

  return (
    <>
      <style>{css}</style>
      <div className="app">

        {/* TOP BAR */}
        <div className="top">
          <span className="logo">ML</span>
          <h1>Auto<em>Publisher</em></h1>
          {sessionActive && fmtTokenTime(sessionSecsLeft) && (
            <span className="cnt" style={{color: tokenColor, borderColor: tokenColor, cursor: 'pointer'}}
              onClick={fetchAuthStatus}>
              🔑 {fmtTokenTime(sessionSecsLeft)}
            </span>
          )}
          {count > 0 && <span className="cnt">{count} publicados</span>}
        </div>

        {/* ── ONBOARDING ── */}
        {screen === S.ONBOARDING && (
          <>
            {/* ── Bloque ML OAuth (sesión centralizada en el Worker) ── */}
            <div className="card">
              <h2>MercadoLibre</h2>
              {sessionActive ? (
                <div className="ok-msg"><span>✓</span><span>
                  Sesión ML activa y compartida (gestionada por el Worker).
                  {fmtTokenTime(sessionSecsLeft) && ` Renueva en ${fmtTokenTime(sessionSecsLeft)}.`}
                  {' '}La renovación es automática para todos los celulares.
                </span></div>
              ) : (
                <div className="warn">No hay sesión ML activa. Autoriza una vez para sembrarla en el Worker.</div>
              )}
              <div className="f"><label>App ID</label>
                <input value={appId} onChange={e => setAppId(e.target.value)} placeholder="3829359465845583" /></div>
              <div className="note">El <code>client_secret</code> ahora vive en el Worker (Cloudflare secret), no en el celular.</div>
              <hr />
              {/* Paso 1: abrir URL de autorización */}
              <button className="btn btn-d" style={{width:'100%'}}
                disabled={!appId}
                onClick={() => window.open(`https://auth.mercadolibre.cl/authorization?response_type=code&client_id=${appId}&redirect_uri=https://httpbin.org/get`, '_blank', 'noopener')}>
                🔐 Paso 1 — Autorizar en MercadoLibre
              </button>
              {/* Paso 2: pegar URL de httpbin → el Worker hace el exchange */}
              <div className="f">
                <label>Paso 2 — Pega la URL de httpbin que te redirigió</label>
                <input value={authCode} onChange={e => { setAuthCode(e.target.value); setAuthErr('') }}
                  placeholder="https://httpbin.org/get?code=TG-..." autoComplete="off" />
              </div>
              <button className="btn btn-y" disabled={!authCode.trim() || exchanging}
                onClick={initAuth}>
                {exchanging ? '⟳ Activando…' : '✓ Activar sesión en el Worker'}
              </button>
              {authErr && <div className="err"><span>⚠</span><span>{authErr}</span></div>}
            </div>

            {/* ── Anthropic + Proxy ── */}
            <div className="card">
              <h2>IA y Proxy</h2>
              <div className="f"><label>Anthropic API Key</label>
                <input type="password" value={anthDraft} onChange={e => setAnthDraft(e.target.value)} placeholder="sk-ant-api03-..." autoComplete="off" /></div>
              <div className="f"><label>Proxy URL</label>
                <input value={proxyDraft} onChange={e => setProxyDraft(e.target.value)} placeholder="https://mlpu-proxy.TU.workers.dev" autoComplete="off" /></div>
              <div className="note">Datos guardados solo en tu navegador (<code>localStorage</code>).</div>
              <div className="toggle-row" style={{paddingTop:0,paddingBottom:0}}>
                <div><div className="toggle-label" style={{fontSize:13}}>Sonido metálico</div>
                  <div className="toggle-sub">Beep al capturar y al publicar</div></div>
                <button className={`toggle${soundOn ? ' on' : ''}`} onClick={() => {
                  const v = !soundOn; setSoundOn(v); LS.set('sound_on', String(v))
                }} />
              </div>
            </div>

            {sessionActive && anthDraft && appId && (
              <button className="btn btn-y" style={{width:'100%',fontSize:15,fontWeight:700}}
                onClick={() => setScreen(S.CAMERA)}>
                ▶ Continuar sin cambios
              </button>
            )}
            <div className="row">
              <button className="btn btn-d btn-sm" style={{flex:'none',padding:'13px 16px'}}
                onClick={() => { setHistorial(loadHistory()); setScreen(S.HISTORY) }}>📋 Historial</button>
              <button className="btn btn-y" style={{flex:1}}
                disabled={!appId || !sessionActive || !anthDraft}
                onClick={() => {
                  LS.set('ml_app_id', appId); LS.set('anthropic_key', anthDraft); LS.set('proxy_url', proxyDraft)
                  setAnthKey(anthDraft); setProxyUrl(proxyDraft)
                  setScreen(S.CAMERA)
                }}>Guardar y comenzar →</button>
            </div>
          </>
        )}

        {/* ── CAMERA ── */}
        {screen === S.CAMERA && (
          <>
            <div className={camClass} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
              {stream && <video ref={videoRef} autoPlay playsInline muted />}
              {stream && <><div className="corner tl"/><div className="corner tr"/><div className="corner bl"/><div className="corner br"/></>}
              {stream && autoCapture && (
                <div className={`focus-lbl${borderState === 'focused' ? ' ready' : ' seeking'}`}>
                  {borderState === 'focused' ? '✓ Enfocado — capturando…' : '⟳ Buscando foco…'}
                </div>
              )}
              {!stream && !dragOver && <div className="cam-idle"><span>📷</span><p>Toca para activar la cámara</p></div>}
              {dragOver && <div className="cam-idle"><span>🖼</span><p>Suelta para agregar fotos</p></div>}
            </div>
            <canvas ref={canvasRef} style={{display:'none'}} />
            <canvas ref={smallCanvas} style={{display:'none'}} />
            {imgs.length > 0 && <PhotoStrip imgs={imgs} onReorder={onReorderImg} onDelete={onDeleteImg} onAdd={onAddPhoto} />}
            <div className="cam-actions">
              {!stream ? (
                <>
                  <div className="row" style={{width:'100%'}}>
                    <button className="btn btn-d" onClick={() => setShowFsCam(true)}>📷 Cámara</button>
                    <button className="btn btn-d" onClick={() => fileRef.current?.click()}>📁 Archivo</button>
                    <input ref={fileRef} type="file" accept="image/*" multiple style={{display:'none'}} onChange={e => handleFiles(e.target.files)} />
                  </div>
                  {imgs.length > 0 && (
                    <button className="btn btn-y" onClick={analyze}>
                      ⚡ Analizar con IA ({imgs.length} foto{imgs.length > 1 ? 's' : ''})
                    </button>
                  )}
                  {drafts.length > 0 && (
                    <button className="btn btn-d btn-sm" style={{width:'100%'}}
                      onClick={() => setScreen(S.DRAFTS)}>
                      📋 Borradores ({drafts.length})
                    </button>
                  )}
                </>
              ) : (
                <>
                  <div className="shutter-ring">
                    <div className="shutter" onClick={capture}><div className="shutter-inner"/></div>
                  </div>
                  <div className="row" style={{width:'100%',justifyContent:'center',gap:16,alignItems:'center'}}>
                    <div style={{display:'flex',alignItems:'center',gap:8,fontSize:12,color:'var(--dim)'}}>
                      Auto-foco
                      <button className={`toggle${autoCapture ? ' on' : ''}`} style={{width:34,height:20}}
                        onClick={() => { setAutoCapture(v => !v); focusCount.current = 0; setBorderState(v => v !== 'neutral' ? 'neutral' : v) }} />
                    </div>
                    <button className="btn btn-sm btn-d" onClick={() => fileRef.current?.click()}>📁 + Fotos</button>
                    <input ref={fileRef} type="file" accept="image/*" multiple style={{display:'none'}} onChange={e => handleFiles(e.target.files)} />
                  </div>
                </>
              )}
            </div>
            <ErrMsg e={err} />
            <button className="btn btn-d" style={{width:'100%',fontSize:12}} onClick={() => { stopCam(); setScreen(S.ONBOARDING) }}>⚙ Config</button>
          </>
        )}

        {/* ── CROP ── */}
        {screen === S.CROP && imgs.length > 0 && (
          <CropScreen
            imgB64={imgs[0]}
            onCrop={croppedB64 => { setImgs(prev => [croppedB64, ...prev.slice(1)]); setScreen(S.PREVIEW) }}
            onSkip={() => setScreen(S.PREVIEW)}
          />
        )}

        {/* ── PREVIEW ── */}
        {screen === S.PREVIEW && imgs.length > 0 && (
          <>
            <div className="cam"><img src={`data:image/jpeg;base64,${imgs[0]}`} alt="preview" /></div>
            {imgs.length > 0 && <PhotoStrip imgs={imgs} onReorder={onReorderImg} onDelete={onDeleteImg} onAdd={onAddPhoto} />}
            <button className="btn btn-y" onClick={analyze}>
              ⚡ Analizar con IA{imgs.length > 1 ? ` (${imgs.length} fotos)` : ''}
            </button>
            <div className="row">
              <button className="btn btn-d" onClick={() => { setImgs([]); startCam() }}>🔄 Repetir</button>
              <button className="btn btn-d" onClick={() => fileRef.current?.click()}>📁 Agregar</button>
              <input ref={fileRef} type="file" accept="image/*" multiple style={{display:'none'}} onChange={e => handleFiles(e.target.files)} />
            </div>
            <ErrMsg e={err} />
          </>
        )}

        {/* ── ANALYZING ── */}
        {screen === S.ANALYZING && (
          <div className="loader">
            <div className="ring"/>
            <div style={{fontSize:16,fontWeight:700}}>Analizando producto</div>
            <div style={{fontSize:12,color:'var(--dim)'}}>4 agentes Claude Vision en paralelo</div>
            <div className="agents">
              {[
                { lbl: '👁  Visión — producto, marca, estado' },
                { lbl: '📝  SEO — título optimizado' },
                { lbl: '💰  Precio — estimando CLP' },
                { lbl: '🏷️  Categoría — buscando en ML' }
              ].map((agent, i) => (
                <div key={i} className="agent-row">
                  <span className={`agent-lbl${analysisDone ? ' done' : ''}`}>{agent.lbl}</span>
                  <div className="agent-bar">
                    <div className="progress-track">
                      {analysisDone
                        ? <div className="progress-fill g" style={{width:'100%'}} />
                        : <div className="progress-fill shimmer" />
                      }
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── CATEGORIES ── */}
        {screen === S.CATEGORIES && analysis && (
          <>
            <div className="thumb"><img src={`data:image/jpeg;base64,${imgs[0]}`} alt="producto"/></div>
            <div>
              <div style={{fontSize:15,fontWeight:700,marginBottom:4,lineHeight:1.3}}>{analysis.title}</div>
              {analysis.brand && <div style={{fontSize:12,color:'var(--dim)',marginBottom:4}}>{analysis.brand}{analysis.model ? ` · ${analysis.model}` : ''}</div>}
              <div style={{fontSize:22,fontWeight:700,color:'var(--b)',marginBottom:12}}>${fmt(analysis.price)} CLP</div>
              <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'2px',color:'var(--dim)',marginBottom:8}}>Selecciona la categoría</div>
            </div>
            <div className="cat-list">
              {cats.length > 0 ? cats.map((c, i) => (
                <div key={i} className={`cat-item${c.manual || !c.id ? ' no-id' : ''}`}
                  onClick={() => { if (!c.id) { setErr('Sin ID — no publicable'); return }; setErr(null); selectCategory(c) }}>
                  <div>
                    <div className="cat-name">{c.name}</div>
                    {c.id ? <div className="cat-id">{c.id}</div> : <div className="cat-id" style={{color:'var(--r)'}}>Sin ID</div>}
                  </div>
                  <span className="arrow">{c.id ? '→' : '✕'}</span>
                </div>
              )) : (
                <div style={{textAlign:'center',color:'var(--dim)',padding:20,fontSize:13,background:'#fff',borderRadius:12,border:'1px solid var(--brd)'}}>
                  No se encontraron categorías
                </div>
              )}
            </div>
            <ErrMsg e={err} />
            <button className="btn btn-d" style={{width:'100%'}} onClick={() => setScreen(S.PREVIEW)}>← Volver</button>
          </>
        )}

        {/* ── CONFIRM ── */}
        {screen === S.CONFIRM && analysis && selCat && (
          <>
            <div className="thumb-sq"><img src={`data:image/jpeg;base64,${imgs[0]}`} alt="producto"/></div>
            <div className="panel">
              <div className="panel-title">Publicación</div>
              <div className="f"><label>Título <span style={{color:'var(--dim)',fontWeight:400}}>(máx 60)</span></label>
                <input className="ei" value={editTitle} maxLength={60} onChange={e => setEditTitle(e.target.value)} placeholder="Título del producto" /></div>
              <div className="f"><label>Descripción</label>
                <textarea className="ei" rows={3} value={editDesc} onChange={e => setEditDesc(e.target.value)} placeholder="Descripción del producto..." /></div>
              <div className="row">
                <div className="f" style={{flex:1}}><label>Condición</label>
                  <select className="ei" value={editCondition} onChange={e => setEditCondition(e.target.value)}>
                    <option value="new">Nuevo</option><option value="used">Usado</option>
                  </select></div>
                <div className="f" style={{flex:1}}><label>Cantidad</label>
                  <input className="ei" type="number" min={1} value={editQty} onChange={e => setEditQty(Math.max(1, parseInt(e.target.value) || 1))} />
                  {editQty < 3 && <span style={{fontSize:11,color:'#e6a817'}}>ML recomienda ≥ 3 unidades</span>}
                </div>
              </div>
              <div className="cat-strip">
                <div><div style={{fontSize:13,fontWeight:600}}>{selCat.name}</div>
                  <div style={{fontSize:11,fontFamily:'var(--mono)',color:'var(--dim)'}}>{selCat.id}</div></div>
                <span className="change" onClick={() => setScreen(S.CATEGORIES)}>Cambiar</span>
              </div>
              {imgs.length > 1 && (
                <div>
                  <div style={{fontSize:10,color:'var(--dim)',marginBottom:6,textTransform:'uppercase',letterSpacing:'1px'}}>Fotos ({imgs.length}) — toca para cambiar principal</div>
                  <PhotoStrip imgs={imgs} onReorder={onReorderImg} onDelete={onDeleteImg} onAdd={onAddPhoto} showAdd={false} />
                </div>
              )}
            </div>

            <div className="panel">
              <div className="panel-title">Precio y tipo de publicación</div>
              <div className="f"><label>Precio de venta (CLP)</label>
                <input className="ei" type="number" min={1} value={editPrice}
                  onChange={e => setEditPrice(parseInt(e.target.value) || 0)}
                  style={{fontSize:18,fontWeight:700,color:'var(--b)'}} /></div>
              {compPrices && (
                <div>
                  <div style={{fontSize:10,color:'var(--dim)',marginBottom:6,textTransform:'uppercase',letterSpacing:'1px'}}>
                    Competencia en ML ({compPrices.count} resultados)
                  </div>
                  <div className="comp-row">
                    {[['Mínimo','min'],['Promedio','avg'],['Máximo','max']].map(([lbl,k]) => (
                      <div key={k} className="comp-item">
                        <div className="cv">${fmt(compPrices[k])}</div>
                        <div className="ck">{lbl}</div>
                      </div>
                    ))}
                  </div>
                  <button className="btn btn-d btn-sm" style={{width:'100%',marginTop:8}}
                    onClick={() => setEditPrice(Math.round(compPrices.avg * 0.95))}>
                    Usar precio competitivo (−5%: ${fmt(Math.round(compPrices.avg * 0.95))})
                  </button>
                </div>
              )}
              <div>
                <div style={{fontSize:10,color:'var(--dim)',marginBottom:6,textTransform:'uppercase',letterSpacing:'1px'}}>
                  Tipo de publicación {loadingComm && <span className="ring-sm" style={{marginLeft:6}}/>}
                </div>
                <div className="listing-tabs">
                  {['free','gold_special','gold_pro'].map(type => {
                    const c = commissions?.[type]
                    const gain = editPrice - (c?.fee || 0) - shippingDeduct - productCost
                    return (
                      <div key={type} className={`lt-tab${listingType === type ? ' active' : ''}`} onClick={() => setListingType(type)}>
                        <div className="lt-name">{LT_LABELS[type]}</div>
                        <div className="lt-fee">{c ? `-$${fmt(c.fee)}` : loadingComm ? '…' : 'n/d'}</div>
                        {c && <div className="lt-gain" style={{color: gain >= 0 ? 'var(--g)' : 'var(--r)'}}>{gain >= 0 ? '+' : ''}{fmt(gain)}</div>}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-title">Calculadora de ganancia</div>
              <div className="f"><label>Costo del producto (CLP)</label>
                <input className="ei" type="number" min={0} value={productCost}
                  onChange={e => setProductCost(parseInt(e.target.value) || 0)} placeholder="0" /></div>
              <div className="profit-rows">
                <div className="prow"><span className="pk">Precio de venta</span><span className="pv">${fmt(editPrice)}</span></div>
                <div className="prow"><span className="pk">Comisión ML ({LT_LABELS[listingType]})</span>
                  <span className="pv" style={{color:'var(--r)'}}>-${fmt(currentFee)}</span></div>
                {freeShipping && <div className="prow"><span className="pk">Envío gratis (estimado)</span>
                  <span className="pv" style={{color:'var(--r)'}}>-${fmt(shippingCost)}</span></div>}
                <div className="prow"><span className="pk">Costo del producto</span>
                  <span className="pv" style={{color:'var(--r)'}}>-${fmt(productCost)}</span></div>
                <div className="prow total">
                  <span className="pk">Ganancia neta</span>
                  <span className="pv" style={{color: profit >= 0 ? 'var(--g)' : 'var(--r)'}}>
                    ${fmt(profit)} <span style={{fontSize:11,fontWeight:400}}>({margin}%)</span>
                  </span>
                </div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-title">Envío</div>
              <div className="toggle-row">
                <div><div className="toggle-label">Envío gratis</div>
                  <div className="toggle-sub">El vendedor asume el costo (~${fmt(shippingCost)} CLP)</div></div>
                <button className={`toggle${freeShipping ? ' on' : ''}`} onClick={() => setFreeShipping(v => !v)} />
              </div>
              {freeShipping && (
                <div className="f"><label>Costo estimado de envío (CLP)</label>
                  <input className="ei" type="number" min={0} value={shippingCost}
                    onChange={e => setShippingCost(parseInt(e.target.value) || 0)} /></div>
              )}
              <div className="toggle-row" style={{borderTop:'1px solid var(--brd)',paddingTop:9}}>
                <div><div className="toggle-label">Retiro en persona</div></div>
                <button className={`toggle${localPickup ? ' on' : ''}`} onClick={() => setLocalPickup(v => !v)} />
              </div>
            </div>

            {(loadingAttrs || requiredAttrs.length > 0) && (
              <div className="panel">
                <div className="panel-title">
                  Atributos requeridos {loadingAttrs && <span className="ring-sm" style={{marginLeft:6}}/>}
                </div>
                {!loadingAttrs && requiredAttrs.length === 0 && (
                  <div style={{fontSize:12,color:'var(--dim)'}}>Sin atributos requeridos.</div>
                )}
                <div className="attr-grid">
                  {requiredAttrs.map(attr => {
                    const val = attrValues[attr.id] || ''
                    const isMissing = !val.toString().trim() || missingAttrIds.includes(attr.id)
                    const onChange = e => {
                      setMissingAttrIds(ids => ids.filter(id => id !== attr.id))
                      setAttrValues(v => ({ ...v, [attr.id]: e.target.value }))
                    }
                    return (
                      <div key={attr.id} className="attr-item">
                        <div className="attr-name" style={missingAttrIds.includes(attr.id) ? {color:'var(--r)'} : {}}>
                          {attr.name}{missingAttrIds.includes(attr.id) ? ' ⚠ requerido' : ''}
                        </div>
                        {attr.values?.length > 0 ? (
                          <select className={`ei${isMissing ? ' attr-missing' : ''}`} value={val} onChange={onChange}>
                            <option value="">— Seleccionar —</option>
                            {attr.values.map(o => <option key={o.id} value={o.name}>{o.name}</option>)}
                          </select>
                        ) : (
                          <input className={`ei${isMissing ? ' attr-missing' : ''}`} value={val} onChange={onChange}
                            placeholder={`Ingresa ${attr.name.toLowerCase()}`} />
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <ErrMsg e={err} />
            <button className="btn btn-d" style={{width:'100%'}} onClick={saveCurrentDraft} disabled={savingDraft}>
              {savingDraft ? '⟳ Guardando…' : '💾 Guardar como borrador'}
            </button>
            <button className="btn btn-y" onClick={publish}
              disabled={loadingAttrs || requiredAttrs.some(a => !attrValues[a.id]?.toString().trim())}>
              🚀 Publicar en MercadoLibre
            </button>
            <button className="btn btn-d" style={{width:'100%'}} onClick={() => setScreen(S.CATEGORIES)}>← Categoría</button>
          </>
        )}

        {/* ── PUBLISHING ── */}
        {screen === S.PUBLISHING && (
          <div className="loader">
            <div className="ring"/>
            <div style={{fontSize:16,fontWeight:700}}>Publicando…</div>
            <div style={{fontSize:12,color:'var(--dim)',marginBottom:8}}>
              Subiendo imagen {uploadProgress.current} de {uploadProgress.total}…
            </div>
            <div className="progress-track" style={{width:'100%'}}>
              <div className="progress-fill" style={{width: `${Math.round(uploadProgress.current / uploadProgress.total * 100)}%`}} />
            </div>
          </div>
        )}

        {/* ── SUCCESS ── */}
        {screen === S.SUCCESS && result && (
          <>
            <div className="success">
              <div className="ok">✅</div>
              <div style={{fontSize:20,fontWeight:700}}>¡Publicado!</div>
              <div style={{fontSize:13,color:'var(--dim)'}}>ID: <code style={{fontFamily:'var(--mono)',color:'var(--b)'}}>{result.id}</code></div>
              {result.permalink && (
                <div className="pub-link">
                  <a href={result.permalink} target="_blank" rel="noopener noreferrer">{result.permalink}</a>
                </div>
              )}
            </div>
            <button className="btn btn-y" onClick={reset}>📷 Publicar otro</button>
            <button className="btn btn-d" style={{width:'100%'}} onClick={() => setScreen(S.ONBOARDING)}>⚙ Config</button>
          </>
        )}

        {/* ── HISTORY ── */}
        {screen === S.HISTORY && (
          <>
            <div className="row" style={{alignItems:'center'}}>
              <div style={{fontSize:15,fontWeight:700,flex:1}}>📋 Historial</div>
              <button className="btn btn-sm btn-d" onClick={() => setScreen(S.ONBOARDING)}>← Volver</button>
            </div>
            {historial.length === 0 ? (
              <div className="empty-hist">📦<br/>Aún no has publicado nada.<br/>
                <span style={{fontSize:12,opacity:.7}}>Tus publicaciones aparecerán aquí.</span></div>
            ) : (
              <>
                <div className="hist-list">
                  {historial.map((h, i) => (
                    <div key={i} className="hist-item"
                      onClick={() => h.permalink && window.open(h.permalink, '_blank', 'noopener')}>
                      <div className="hist-thumb">
                        {h.thumbnail
                          ? <img src={`data:image/jpeg;base64,${h.thumbnail}`} alt={h.title} />
                          : <span style={{fontSize:22}}>📦</span>
                        }
                      </div>
                      <div className="hist-info">
                        <div className="hist-title">{h.title}</div>
                        <div className="hist-meta">
                          ${fmt(h.price)} CLP · {h.category_name}<br/>
                          {new Date(h.fecha).toLocaleDateString('es-CL', {day:'2-digit',month:'short',year:'numeric'})}
                        </div>
                      </div>
                      <div style={{textAlign:'right'}}>
                        <div className="hist-gain">+${fmt(h.ganancia_neta)}</div>
                        <div style={{fontSize:9,color:'var(--dim)',marginTop:2}}>ganancia</div>
                      </div>
                    </div>
                  ))}
                </div>
                <button className="btn btn-r" onClick={() => {
                  if (window.confirm('¿Borrar todo el historial? Esta acción no se puede deshacer.')) {
                    try { localStorage.removeItem(HIST_KEY) } catch {}
                    setHistorial([])
                  }
                }}>🗑 Borrar historial</button>
              </>
            )}
          </>
        )}

        {/* ── DRAFTS ── */}
        {screen === S.DRAFTS && (
          <>
            <div className="row" style={{alignItems:'center'}}>
              <div style={{fontSize:15,fontWeight:700,flex:1}}>📋 Borradores {drafts.length > 0 && `(${drafts.length})`}</div>
              <button className="btn btn-sm btn-d" onClick={() => setScreen(S.CAMERA)}>← Volver</button>
            </div>

            {batchProgress && (
              <div className="panel">
                <div className="panel-title">Publicando {batchProgress.current}/{batchProgress.total}</div>
                <div style={{fontSize:13,color:'var(--dim)',marginBottom:8,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{batchProgress.title}</div>
                <div className="progress-track">
                  <div className="progress-fill" style={{width: `${Math.round(batchProgress.current / batchProgress.total * 100)}%`}} />
                </div>
              </div>
            )}

            {err && <ErrMsg e={err} />}

            {drafts.length === 0 ? (
              <div className="empty-hist">📝<br/>No hay borradores guardados.<br/>
                <span style={{fontSize:12}}>Guarda productos desde la pantalla de confirmación.</span></div>
            ) : (
              <>
                {selectedDrafts.size > 0 && (
                  <button className="btn btn-y" onClick={publishBatch} disabled={!!batchProgress}>
                    🚀 Publicar seleccionados ({selectedDrafts.size})
                  </button>
                )}
                <div className="hist-list">
                  {drafts.map(d => (
                    <div key={d.id} className="hist-item" style={{cursor:'default'}}>
                      <input type="checkbox" checked={selectedDrafts.has(d.id)}
                        onChange={e => setSelectedDrafts(prev => {
                          const next = new Set(prev)
                          e.target.checked ? next.add(d.id) : next.delete(d.id)
                          return next
                        })}
                        style={{width:18,height:18,accentColor:'var(--b)',flexShrink:0,cursor:'pointer'}} />
                      <div className="hist-thumb" onClick={() => loadDraftToConfirm(d)} style={{cursor:'pointer'}}>
                        {d.thumb
                          ? <img src={`data:image/jpeg;base64,${d.thumb}`} alt={d.editTitle} />
                          : <span style={{fontSize:20}}>📦</span>}
                      </div>
                      <div className="hist-info" style={{cursor:'pointer'}} onClick={() => loadDraftToConfirm(d)}>
                        <div className="hist-title">{d.editTitle || 'Sin título'}</div>
                        <div className="hist-meta">
                          ${fmt(d.editPrice)} · {d.selCat?.name || ''}<br/>
                          {new Date(d.created).toLocaleDateString('es-CL', {day:'2-digit',month:'short',year:'numeric'})}
                        </div>
                      </div>
                      <div style={{display:'flex',flexDirection:'column',gap:4,flexShrink:0}}>
                        <button className="btn btn-sm btn-d" style={{fontSize:11,padding:'5px 10px'}}
                          onClick={() => loadDraftToConfirm(d)}>✏️ Editar</button>
                        <button className="btn btn-sm btn-r" style={{fontSize:11,padding:'5px 10px'}}
                          onClick={() => { deleteDraft(d.id); setDrafts(loadDrafts()); setSelectedDrafts(p => { const n=new Set(p); n.delete(d.id); return n }) }}>
                          🗑
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <button className="btn btn-r" onClick={() => {
                  if (window.confirm('¿Borrar todos los borradores?')) {
                    try { localStorage.removeItem(DRAFTS_KEY) } catch {}
                    setDrafts([]); setSelectedDrafts(new Set())
                  }
                }}>🗑 Borrar todos los borradores</button>
              </>
            )}
          </>
        )}

      </div>

      {showFsCam && (
        <FullscreenCamera
          onPhotoCaptured={onFsPhotoCaptured}
          onClose={() => setShowFsCam(false)}
        />
      )}
    </>
  )
}
