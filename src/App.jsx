import { useState, useRef, useCallback, useEffect } from 'react'
import { analyzeProduct, fillAttributesWithAI } from './agents/orchestrator.js'

const ML = 'https://api.mercadolibre.com'

const S = {
  ONBOARDING: 'onboarding', CAMERA: 'camera', PREVIEW: 'preview',
  ANALYZING: 'analyzing', CATEGORIES: 'categories',
  CONFIRM: 'confirm', PUBLISHING: 'publishing', SUCCESS: 'success'
}

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const now = ctx.currentTime
    ;[[880, 0, 0.12], [1320, 0.14, 0.14]].forEach(([freq, delay, dur]) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.type = 'sine'; osc.frequency.value = freq
      gain.gain.setValueAtTime(0, now + delay)
      gain.gain.linearRampToValueAtTime(0.4, now + delay + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.001, now + delay + dur)
      osc.start(now + delay); osc.stop(now + delay + dur + 0.05)
    })
  } catch (_) {}
}

const fmt = n => Number(n || 0).toLocaleString('es-CL')

const css = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#06060a;--s1:#0e0e18;--s2:#16162a;--s3:#1e1e32;
  --brd:#28283e;--brd2:#38385a;
  --y:#ffe234;--g:#00d4a0;--r:#ff4f7b;--b:#3483fa;
  --txt:#e0e0f0;--dim:#5858a0;--mono:'JetBrains Mono',monospace;
}
body{background:var(--bg);color:var(--txt);font-family:'Space Grotesk',sans-serif;min-height:100dvh}
.app{max-width:430px;margin:0 auto;padding:16px 14px 80px;display:flex;flex-direction:column;gap:16px}

.top{display:flex;align-items:center;gap:8px;padding-bottom:14px;border-bottom:1px solid var(--brd)}
.logo{background:var(--y);color:#000;font-size:9px;font-weight:800;letter-spacing:2px;padding:4px 8px;border-radius:5px}
.top h1{font-size:16px;font-weight:700;flex:1}.top h1 em{color:var(--y);font-style:normal}
.cnt{font-size:11px;font-family:var(--mono);color:var(--dim);background:var(--s2);border:1px solid var(--brd);border-radius:20px;padding:3px 9px}

.card{background:var(--s2);border:1px solid var(--brd);border-radius:18px;padding:20px;display:flex;flex-direction:column;gap:13px}
.card h2{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:var(--dim)}

.f{display:flex;flex-direction:column;gap:4px}
.f label,.lbl{font-size:10px;font-weight:700;color:var(--dim);text-transform:uppercase;letter-spacing:1.2px}
.f input,.f select,.f textarea,.ei{background:var(--s1);border:1px solid var(--brd);border-radius:9px;color:var(--txt);font-family:var(--mono);font-size:12px;padding:10px 12px;outline:none;width:100%;transition:border-color .15s;resize:vertical}
.f input:focus,.f select:focus,.f textarea:focus,.ei:focus{border-color:var(--y)}
.f input::placeholder,.ei::placeholder{color:var(--dim);opacity:.6}
.f select option{background:var(--s1)}
.note{font-size:11px;color:var(--dim);background:var(--s3);border:1px solid var(--brd);border-radius:8px;padding:10px 13px;line-height:1.8}
.note code{color:var(--g);font-family:var(--mono);font-size:10px;word-break:break-all}

.btn{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:14px;border:none;border-radius:12px;cursor:pointer;padding:13px 18px;transition:all .1s;display:inline-flex;align-items:center;justify-content:center;gap:7px}
.btn:active{transform:scale(.96)}
.btn-y{background:var(--y);color:#000;width:100%;font-size:15px;padding:15px}
.btn-y:hover{background:#f0d400}
.btn-y:disabled{background:var(--brd);color:var(--dim);cursor:not-allowed;transform:none}
.btn-d{background:var(--s2);color:var(--txt);border:1px solid var(--brd);flex:1}
.btn-d:hover{border-color:var(--brd2)}
.btn-sm{font-size:12px;padding:7px 13px;border-radius:8px}
.row{display:flex;gap:10px}

.cam{position:relative;border-radius:20px;overflow:hidden;aspect-ratio:4/3;background:#000;border:1px solid var(--brd)}
.cam video,.cam img{width:100%;height:100%;object-fit:cover;display:block}
.cam-idle{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--dim)}
.cam-idle span{font-size:48px}.cam-idle p{font-size:12px}
.corner{position:absolute;width:26px;height:26px;border-color:var(--y);border-style:solid;opacity:.6}
.corner.tl{top:14px;left:14px;border-width:2px 0 0 2px;border-radius:3px 0 0 0}
.corner.tr{top:14px;right:14px;border-width:2px 2px 0 0;border-radius:0 3px 0 0}
.corner.bl{bottom:14px;left:14px;border-width:0 0 2px 2px;border-radius:0 0 0 3px}
.corner.br{bottom:14px;right:14px;border-width:0 2px 2px 0;border-radius:0 0 3px 0}
.shutter{width:70px;height:70px;border-radius:50%;background:var(--y);border:4px solid rgba(255,226,52,.25);cursor:pointer;box-shadow:0 0 0 2px var(--y);margin:0 auto;transition:transform .1s;display:flex;align-items:center;justify-content:center}
.shutter:active{transform:scale(.88)}
.shutter-ring{width:86px;height:86px;border-radius:50%;border:1.5px solid rgba(255,226,52,.2);display:flex;align-items:center;justify-content:center;margin:0 auto}
.shutter-inner{width:30px;height:30px;border-radius:50%;background:#000;pointer-events:none}
.cam-actions{display:flex;flex-direction:column;gap:12px;align-items:center}

.loader{background:var(--s2);border:1px solid var(--brd);border-radius:18px;padding:36px 22px;display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center}
.ring{width:72px;height:72px;border-radius:50%;border:3px solid var(--brd2);border-top-color:var(--y);animation:spin .7s linear infinite}
.ring-sm{width:16px;height:16px;border-radius:50%;border:2px solid var(--brd2);border-top-color:var(--y);animation:spin .7s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.agents{display:flex;flex-direction:column;gap:7px;width:100%;margin-top:4px}
.agent{display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--s3);border-radius:9px;font-size:12px;color:var(--dim)}
.agent .dot{width:6px;height:6px;border-radius:50%;background:var(--y);animation:blink .9s infinite;flex-shrink:0}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.1}}

.thumb{border-radius:14px;overflow:hidden;aspect-ratio:4/3;border:1px solid var(--brd)}
.thumb img{width:100%;height:100%;object-fit:cover}
.thumb-16{border-radius:14px;overflow:hidden;aspect-ratio:16/9;border:1px solid var(--brd)}
.thumb-16 img{width:100%;height:100%;object-fit:cover}

.cat-list{display:flex;flex-direction:column;gap:8px}
.cat-item{background:var(--s2);border:1px solid var(--brd);border-radius:13px;padding:13px 15px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;transition:all .12s}
.cat-item:hover{border-color:var(--y);background:var(--s3)}
.cat-item.no-id{opacity:.6;cursor:not-allowed}
.cat-name{font-size:14px;font-weight:600}
.cat-id{font-size:11px;font-family:var(--mono);color:var(--dim);margin-top:2px}
.arrow{color:var(--y);font-size:16px}

/* CONFIRM panels */
.panel{background:var(--s2);border:1px solid var(--brd);border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.panel-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.8px;color:var(--dim)}

.listing-tabs{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}
.lt-tab{background:var(--s3);border:1px solid var(--brd);border-radius:9px;padding:8px 6px;cursor:pointer;text-align:center;transition:all .12s}
.lt-tab.active{border-color:var(--y);background:rgba(255,226,52,.07)}
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
.toggle{width:40px;height:22px;border-radius:11px;background:var(--brd2);cursor:pointer;position:relative;transition:background .15s;flex-shrink:0;border:none}
.toggle.on{background:var(--y)}
.toggle::after{content:'';position:absolute;width:16px;height:16px;border-radius:50%;background:#fff;top:3px;left:3px;transition:left .15s}
.toggle.on::after{left:21px;background:#000}

.attr-grid{display:flex;flex-direction:column;gap:8px}
.attr-item{display:flex;flex-direction:column;gap:3px}
.attr-name{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--dim)}
.attr-missing{border-color:var(--r) !important}

.cat-strip{display:flex;align-items:center;justify-content:space-between;background:var(--s3);border:1px solid var(--brd);border-radius:9px;padding:10px 13px}
.change{font-size:12px;color:var(--dim);cursor:pointer;text-decoration:underline}
.change:hover{color:var(--y)}
.badge{display:inline-flex;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700}
.badge.new{background:rgba(0,212,160,.12);color:var(--g);border:1px solid rgba(0,212,160,.25)}
.badge.used{background:rgba(255,226,52,.1);color:var(--y);border:1px solid rgba(255,226,52,.2)}

.success{background:var(--s2);border:1px solid var(--g);border-radius:18px;padding:32px 22px;display:flex;flex-direction:column;align-items:center;gap:13px;text-align:center}
.ok{font-size:52px}
.pub-link{font-family:var(--mono);font-size:11px;color:var(--b);word-break:break-all;background:var(--s3);border-radius:8px;padding:10px 13px;width:100%;text-align:left}
.pub-link a{color:inherit}

.err{background:rgba(255,79,123,.07);border:1px solid rgba(255,79,123,.3);border-radius:10px;padding:11px 14px;font-size:12px;color:var(--r);display:flex;gap:8px;align-items:flex-start;word-break:break-word}
.warn{background:rgba(255,226,52,.06);border:1px solid rgba(255,226,52,.25);border-radius:10px;padding:10px 13px;font-size:12px;color:var(--y)}
hr{border:none;border-top:1px solid var(--brd)}
::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:var(--brd);border-radius:2px}
`

const LS = {
  get: k => { try { return localStorage.getItem(k) || '' } catch { return '' } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch {} }
}

export default function App() {
  const [screen, setScreen] = useState(S.ONBOARDING)
  const [appId,      setAppId]      = useState(() => LS.get('ml_app_id')    || '3829359465845583')
  const [token,      setToken]      = useState(() => LS.get('ml_token')      || '')
  const [tokenDraft, setTokenDraft] = useState(() => LS.get('ml_token')      || '')
  const [anthKey,    setAnthKey]    = useState(() => LS.get('anthropic_key') || '')
  const [anthDraft,  setAnthDraft]  = useState(() => LS.get('anthropic_key') || '')
  const [proxyUrl,   setProxyUrl]   = useState(() => LS.get('proxy_url')     || 'https://broad-pond-c45emlpup.aronricocl.workers.dev')
  const [proxyDraft, setProxyDraft] = useState(() => LS.get('proxy_url')     || 'https://broad-pond-c45emlpup.aronricocl.workers.dev')

  const mlBase = useCallback(path => {
    if (proxyUrl) return `${proxyUrl.replace(/\/$/, '')}/ml${path}`
    return `${ML}${path}`
  }, [proxyUrl])

  const videoRef  = useRef(null)
  const canvasRef = useRef(null)
  const fileRef   = useRef(null)
  const commTimer = useRef(null)

  const [stream,   setStream]   = useState(null)
  const [img,      setImg]      = useState(null)
  const [analysis, setAnalysis] = useState(null)
  const [cats,     setCats]     = useState([])
  const [selCat,   setSelCat]   = useState(null)
  const [result,   setResult]   = useState(null)
  const [err,      setErr]      = useState(null)
  const [count,    setCount]    = useState(0)

  // ── CONFIRM editable fields
  const [editTitle,     setEditTitle]     = useState('')
  const [editPrice,     setEditPrice]     = useState(0)
  const [editDesc,      setEditDesc]      = useState('')
  const [editCondition, setEditCondition] = useState('used')
  const [editQty,       setEditQty]       = useState(1)
  const [listingType,   setListingType]   = useState('free')

  // ── Attributes
  const [requiredAttrs, setRequiredAttrs] = useState([])
  const [attrValues,    setAttrValues]    = useState({})
  const [loadingAttrs,  setLoadingAttrs]  = useState(false)

  // ── Commissions
  const [commissions,  setCommissions]  = useState(null)
  const [loadingComm,  setLoadingComm]  = useState(false)

  // ── Competitive prices
  const [compPrices, setCompPrices] = useState(null)

  // ── Shipping & costs
  const [freeShipping,  setFreeShipping]  = useState(false)
  const [localPickup,   setLocalPickup]   = useState(false)
  const [shippingCost,  setShippingCost]  = useState(3000)
  const [productCost,   setProductCost]   = useState(0)

  // ── CAMERA
  const stopCam = useCallback(() => {
    if (stream) { stream.getTracks().forEach(t => t.stop()); setStream(null) }
  }, [stream])

  const startCam = useCallback(async () => {
    setErr(null)
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 } } })
      setStream(s); setImg(null); setScreen(S.CAMERA)
      setTimeout(() => { if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.play() } }, 80)
      console.log('[cam] activa')
    } catch (e) { setErr('Cámara no disponible: ' + e.message) }
  }, [])

  const capture = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return
    const v = videoRef.current, c = canvasRef.current
    c.width = v.videoWidth || 1280; c.height = v.videoHeight || 720
    c.getContext('2d').drawImage(v, 0, 0)
    setImg(c.toDataURL('image/jpeg', 0.92).split(',')[1])
    stopCam(); setScreen(S.PREVIEW)
  }, [stopCam])

  const handleFile = e => {
    const f = e.target.files?.[0]; if (!f) return
    const r = new FileReader()
    r.onload = ev => { setImg(ev.target.result.split(',')[1]); stopCam(); setScreen(S.PREVIEW) }
    r.readAsDataURL(f)
  }

  // ── ANALYZE
  const analyze = useCallback(async () => {
    if (!img) return
    setErr(null); setScreen(S.ANALYZING)
    try {
      const a = await analyzeProduct(img, anthKey)
      setAnalysis(a)
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
      if (found.length === 0) {
        (a.categorySearches || []).forEach((n, i) => found.push({ id: '', name: n, manual: true }))
      }
      setCats(found.slice(0, 5))
      playBeep()
      setScreen(S.CATEGORIES)
    } catch (e) {
      setErr('Error IA: ' + e.message); setScreen(S.PREVIEW)
    }
  }, [img, anthKey])

  // ── SELECT CATEGORY → enter CONFIRM
  const selectCategory = useCallback(cat => {
    if (!cat.id) { setErr('Categoría sin ID válido.'); return }
    setErr(null)
    setSelCat(cat)
    setEditTitle(analysis?.title || '')
    setEditPrice(analysis?.price || 0)
    setEditDesc(analysis?.description || '')
    setEditCondition(analysis?.condition || 'used')
    setEditQty(1)
    setListingType('free')
    setRequiredAttrs([])
    setAttrValues({})
    setCommissions(null)
    setCompPrices(null)
    setFreeShipping(false)
    setLocalPickup(false)
    setScreen(S.CONFIRM)
  }, [analysis])

  // ── FETCH ATTRIBUTES + COMP PRICES when entering CONFIRM
  useEffect(() => {
    if (screen !== S.CONFIRM || !selCat?.id) return
    let cancelled = false

    // Attributes
    ;(async () => {
      setLoadingAttrs(true)
      try {
        const r = await fetch(`${ML}/categories/${selCat.id}/attributes`)
        if (cancelled) return
        const data = await r.json()
        const needed = (Array.isArray(data) ? data : [])
          .filter(a => a.tags?.required && !a.tags?.fixed)
        console.log('[attrs] requeridos:', needed.map(a => a.id))
        if (!cancelled) setRequiredAttrs(needed)
        if (needed.length > 0 && anthKey && !cancelled) {
          const filled = await fillAttributesWithAI(needed, analysis, anthKey)
          if (!cancelled) setAttrValues(filled)
        }
      } catch (e) {
        console.warn('[attrs]', e.message)
      } finally {
        if (!cancelled) setLoadingAttrs(false)
      }
    })()

    // Competitive prices
    ;(async () => {
      try {
        const r = await fetch(`${ML}/sites/MLC/search?category=${selCat.id}&q=${encodeURIComponent(analysis?.title || '')}&limit=20`)
        if (cancelled) return
        const data = await r.json()
        const prices = (data.results || []).map(i => i.price).filter(p => p > 0).sort((a, b) => a - b)
        if (prices.length > 0 && !cancelled) {
          const mid = Math.floor(prices.length / 2)
          setCompPrices({
            min:    prices[0],
            max:    prices[prices.length - 1],
            avg:    Math.round(prices.reduce((s, p) => s + p, 0) / prices.length),
            median: prices.length % 2 ? prices[mid] : Math.round((prices[mid - 1] + prices[mid]) / 2),
            count:  prices.length
          })
        }
      } catch (e) { console.warn('[comp-prices]', e.message) }
    })()

    return () => { cancelled = true }
  }, [screen, selCat?.id])

  // ── FETCH COMMISSIONS (debounced 500ms on price/type change)
  useEffect(() => {
    if (screen !== S.CONFIRM || !selCat?.id || !editPrice) return
    if (commTimer.current) clearTimeout(commTimer.current)
    commTimer.current = setTimeout(async () => {
      setLoadingComm(true)
      try {
        const types = ['free', 'gold_special', 'gold_pro']
        const results = await Promise.allSettled(types.map(async type => {
          const url = mlBase(`/sites/MLC/listing_prices?price=${editPrice}&listing_type_id=${type}&category_id=${selCat.id}`)
          const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
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
        console.log('[commissions]', comm)
      } catch (e) {
        console.warn('[commissions]', e.message)
        setCommissions(null)
      } finally {
        setLoadingComm(false)
      }
    }, 500)
  }, [editPrice, listingType, screen, selCat?.id, token, mlBase])

  // ── PROFIT CALC
  const currentFee      = commissions?.[listingType]?.fee || 0
  const shippingDeduct  = freeShipping ? shippingCost : 0
  const profit          = editPrice - currentFee - shippingDeduct - productCost
  const margin          = editPrice > 0 ? Math.round((profit / editPrice) * 100) : 0

  // ── PUBLISH
  const publish = useCallback(async () => {
    if (!selCat?.id || !analysis) return
    // Validate required attrs
    const missing = requiredAttrs.filter(a => !attrValues[a.id]?.toString().trim())
    if (missing.length > 0) {
      setErr('Faltan atributos requeridos: ' + missing.map(a => a.name).join(', '))
      return
    }
    setScreen(S.PUBLISHING); setErr(null)

    try {
      // Upload image
      const pictures = []
      try {
        const blob = await (await fetch(`data:image/jpeg;base64,${img}`)).blob()
        const form = new FormData(); form.append('file', blob, 'product.jpg')
        const pr = await fetch(mlBase('/pictures/items/upload'), {
          method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
        })
        if (pr.ok) { const pd = await pr.json(); pictures.push({ id: pd.id }); console.log('[publish] img id:', pd.id) }
        else console.warn('[publish] img upload failed:', await pr.json())
      } catch (e) { console.warn('[publish] img error:', e.message) }

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
        shipping: { mode: 'me2', free_shipping: freeShipping, local_pick_up: localPickup },
        sale_terms: [
          { id: 'WARRANTY_TYPE', value_name: 'Garantía del vendedor' },
          { id: 'WARRANTY_TIME',  value_name: '30 días' }
        ]
      }

      console.log('[publish] payload:', payload)
      const r = await fetch(mlBase('/items'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const data = await r.json()
      console.log('[publish] response:', data)

      if (!r.ok) {
        const causes = (data.cause || []).map(c => c.message || c.code || JSON.stringify(c)).join(' | ')
        console.error('[publish] causes:', JSON.stringify(data.cause, null, 2))
        throw new Error(`${data.message}${causes ? ': ' + causes : ''}`)
      }

      setResult(data); setCount(c => c + 1); playBeep(); setScreen(S.SUCCESS)
    } catch (e) {
      console.error('[publish]', e)
      setErr('Error publicando: ' + e.message)
      setScreen(S.CONFIRM)
    }
  }, [selCat, analysis, img, token, mlBase, editTitle, editPrice, editDesc, editCondition, editQty, listingType, requiredAttrs, attrValues, freeShipping, localPickup])

  const reset = () => {
    setImg(null); setAnalysis(null); setCats([]); setSelCat(null)
    setResult(null); setErr(null); setRequiredAttrs([]); setAttrValues({})
    setCommissions(null); setCompPrices(null)
    setScreen(S.CAMERA)
  }

  useEffect(() => () => stopCam(), [])

  // ── LISTING TYPE labels
  const LT_LABELS = { free: 'Gratuita', gold_special: 'Clásica', gold_pro: 'Premium' }

  return (
    <>
      <style>{css}</style>
      <div className="app">

        {/* TOP BAR */}
        <div className="top">
          <span className="logo">ML</span>
          <h1>Auto<em>Publisher</em></h1>
          {count > 0 && <span className="cnt">{count} publicados</span>}
        </div>

        {/* ── ONBOARDING ── */}
        {screen === S.ONBOARDING && (
          <>
            <div className="card">
              <h2>Configuración</h2>
              <div className="f"><label>App ID MercadoLibre</label>
                <input value={appId} onChange={e => setAppId(e.target.value)} placeholder="3829359465845583" /></div>
              <hr />
              <div className="note">
                Token: abre <code>auth.mercadolibre.cl/authorization?response_type=code&client_id={appId}&redirect_uri=https://httpbin.org/get</code>, autoriza y canjea el <code>code</code> por token.
              </div>
              <div className="f"><label>Access Token ML</label>
                <input value={tokenDraft} onChange={e => setTokenDraft(e.target.value)} placeholder="APP_USR-..." autoComplete="off" /></div>
              <hr />
              <div className="f"><label>Anthropic API Key</label>
                <input type="password" value={anthDraft} onChange={e => setAnthDraft(e.target.value)} placeholder="sk-ant-api03-..." autoComplete="off" /></div>
              <hr />
              <div className="f"><label>Proxy URL <span style={{color:'var(--g)',fontSize:9,fontWeight:400}}>(para publicar)</span></label>
                <input value={proxyDraft} onChange={e => setProxyDraft(e.target.value)} placeholder="https://mlpu-proxy.TU.workers.dev" autoComplete="off" /></div>
              <div className="note">Datos guardados solo en tu navegador (<code>localStorage</code>).</div>
            </div>
            <button className="btn btn-y" disabled={!appId || !tokenDraft || !anthDraft}
              onClick={() => {
                LS.set('ml_app_id', appId); LS.set('ml_token', tokenDraft)
                LS.set('anthropic_key', anthDraft); LS.set('proxy_url', proxyDraft)
                setToken(tokenDraft); setAnthKey(anthDraft); setProxyUrl(proxyDraft)
                setScreen(S.CAMERA)
              }}>Comenzar →</button>
          </>
        )}

        {/* ── CAMERA ── */}
        {screen === S.CAMERA && (
          <>
            <div className="cam">
              {stream && <video ref={videoRef} autoPlay playsInline muted />}
              {stream && <><div className="corner tl"/><div className="corner tr"/><div className="corner bl"/><div className="corner br"/></>}
              {!stream && <div className="cam-idle"><span>📷</span><p>Toca para activar la cámara</p></div>}
            </div>
            <canvas ref={canvasRef} style={{display:'none'}} />
            <div className="cam-actions">
              {!stream ? (
                <div className="row" style={{width:'100%'}}>
                  <button className="btn btn-d" onClick={startCam}>📷 Cámara</button>
                  <button className="btn btn-d" onClick={() => fileRef.current?.click()}>📁 Archivo</button>
                  <input ref={fileRef} type="file" accept="image/*" style={{display:'none'}} onChange={handleFile} />
                </div>
              ) : (
                <div className="shutter-ring">
                  <div className="shutter" onClick={capture}><div className="shutter-inner"/></div>
                </div>
              )}
            </div>
            {err && <div className="err"><span>⚠</span><span>{err}</span></div>}
          </>
        )}

        {/* ── PREVIEW ── */}
        {screen === S.PREVIEW && img && (
          <>
            <div className="cam"><img src={`data:image/jpeg;base64,${img}`} alt="preview" /></div>
            <button className="btn btn-y" onClick={analyze}>⚡ Analizar con IA</button>
            <div className="row">
              <button className="btn btn-d" onClick={() => { setImg(null); startCam() }}>🔄 Repetir</button>
              <button className="btn btn-d" onClick={() => fileRef.current?.click()}>📁 Cambiar</button>
              <input ref={fileRef} type="file" accept="image/*" style={{display:'none'}} onChange={handleFile} />
            </div>
            {err && <div className="err"><span>⚠</span><span>{err}</span></div>}
          </>
        )}

        {/* ── ANALYZING ── */}
        {screen === S.ANALYZING && (
          <div className="loader">
            <div className="ring"/>
            <div style={{fontSize:16,fontWeight:700}}>Analizando producto</div>
            <div style={{fontSize:12,color:'var(--dim)'}}>4 agentes Claude Vision en paralelo</div>
            <div className="agents">
              {['👁  Visión — producto, marca, estado','📝  SEO — título optimizado','💰  Precio — estimando CLP','🏷️  Categoría — buscando en ML'].map((t,i) => (
                <div key={i} className="agent"><span className="dot"/>{t}</div>
              ))}
            </div>
          </div>
        )}

        {/* ── CATEGORIES ── */}
        {screen === S.CATEGORIES && analysis && (
          <>
            <div className="thumb"><img src={`data:image/jpeg;base64,${img}`} alt="producto"/></div>
            <div>
              <div style={{fontSize:15,fontWeight:700,marginBottom:4,lineHeight:1.3}}>{analysis.title}</div>
              {analysis.brand && <div style={{fontSize:12,color:'var(--dim)',marginBottom:4}}>{analysis.brand}{analysis.model ? ` · ${analysis.model}` : ''}</div>}
              <div style={{fontSize:22,fontWeight:700,color:'var(--y)',marginBottom:12}}>${fmt(analysis.price)} CLP</div>
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
                <div style={{textAlign:'center',color:'var(--dim)',padding:20,fontSize:13,background:'var(--s2)',borderRadius:12,border:'1px solid var(--brd)'}}>
                  No se encontraron categorías
                </div>
              )}
            </div>
            {err && <div className="err"><span>⚠</span><span>{err}</span></div>}
            <button className="btn btn-d" style={{width:'100%'}} onClick={() => setScreen(S.PREVIEW)}>← Volver</button>
          </>
        )}

        {/* ── CONFIRM ── */}
        {screen === S.CONFIRM && analysis && selCat && (
          <>
            {/* Thumbnail */}
            <div className="thumb-16"><img src={`data:image/jpeg;base64,${img}`} alt="producto"/></div>

            {/* Editable fields */}
            <div className="panel">
              <div className="panel-title">Publicación</div>
              <div className="f"><label>Título <span style={{color:'var(--dim)',fontWeight:400}}>(máx 60)</span></label>
                <input className="ei" value={editTitle} maxLength={60}
                  onChange={e => setEditTitle(e.target.value)} placeholder="Título del producto" /></div>
              <div className="f"><label>Descripción</label>
                <textarea className="ei" rows={3} value={editDesc}
                  onChange={e => setEditDesc(e.target.value)} placeholder="Descripción del producto..." /></div>
              <div className="row">
                <div className="f" style={{flex:1}}><label>Condición</label>
                  <select className="ei" value={editCondition} onChange={e => setEditCondition(e.target.value)}>
                    <option value="new">Nuevo</option>
                    <option value="used">Usado</option>
                  </select>
                </div>
                <div className="f" style={{flex:1}}><label>Cantidad</label>
                  <input className="ei" type="number" min={1} value={editQty}
                    onChange={e => setEditQty(Math.max(1, parseInt(e.target.value) || 1))} /></div>
              </div>
              <div className="cat-strip">
                <div><div style={{fontSize:13,fontWeight:600}}>{selCat.name}</div>
                  <div style={{fontSize:11,fontFamily:'var(--mono)',color:'var(--dim)'}}>{selCat.id}</div></div>
                <span className="change" onClick={() => setScreen(S.CATEGORIES)}>Cambiar</span>
              </div>
            </div>

            {/* Precio + Tipo de publicación */}
            <div className="panel">
              <div className="panel-title">Precio y tipo de publicación</div>
              <div className="f"><label>Precio de venta (CLP)</label>
                <input className="ei" type="number" min={1} value={editPrice}
                  onChange={e => setEditPrice(parseInt(e.target.value) || 0)}
                  style={{fontSize:18,fontWeight:700,color:'var(--y)'}} /></div>

              {/* Competitive prices */}
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
                    Usar precio competitivo (−5% del promedio: ${fmt(Math.round(compPrices.avg * 0.95))})
                  </button>
                </div>
              )}

              {/* Listing type selector */}
              <div>
                <div style={{fontSize:10,color:'var(--dim)',marginBottom:6,textTransform:'uppercase',letterSpacing:'1px'}}>
                  Tipo de publicación {loadingComm && <span className="ring-sm" style={{marginLeft:6}}/>}
                </div>
                <div className="listing-tabs">
                  {['free','gold_special','gold_pro'].map(type => {
                    const c = commissions?.[type]
                    const gain = editPrice - (c?.fee || 0) - shippingDeduct - productCost
                    return (
                      <div key={type} className={`lt-tab${listingType === type ? ' active' : ''}`}
                        onClick={() => setListingType(type)}>
                        <div className="lt-name">{LT_LABELS[type]}</div>
                        <div className="lt-fee">{c ? `-$${fmt(c.fee)}` : loadingComm ? '…' : 'n/d'}</div>
                        {c && <div className="lt-gain" style={{color: gain >= 0 ? 'var(--g)' : 'var(--r)'}}>
                          {gain >= 0 ? '+' : ''}{fmt(gain)}
                        </div>}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            {/* Profit calculator */}
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

            {/* Shipping toggles */}
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

            {/* Required attributes */}
            {(loadingAttrs || requiredAttrs.length > 0) && (
              <div className="panel">
                <div className="panel-title">
                  Atributos requeridos {loadingAttrs && <span className="ring-sm" style={{marginLeft:6}}/>}
                </div>
                {!loadingAttrs && requiredAttrs.length === 0 && (
                  <div style={{fontSize:12,color:'var(--dim)'}}>Sin atributos requeridos para esta categoría.</div>
                )}
                <div className="attr-grid">
                  {requiredAttrs.map(attr => {
                    const val = attrValues[attr.id] || ''
                    const isEmpty = !val.toString().trim()
                    return (
                      <div key={attr.id} className="attr-item">
                        <div className="attr-name">{attr.name}</div>
                        {attr.values?.length > 0 ? (
                          <select className={`ei${isEmpty ? ' attr-missing' : ''}`}
                            value={val} onChange={e => setAttrValues(v => ({ ...v, [attr.id]: e.target.value }))}>
                            <option value="">— Seleccionar —</option>
                            {attr.values.map(o => <option key={o.id} value={o.name}>{o.name}</option>)}
                          </select>
                        ) : (
                          <input className={`ei${isEmpty ? ' attr-missing' : ''}`}
                            value={val} onChange={e => setAttrValues(v => ({ ...v, [attr.id]: e.target.value }))}
                            placeholder={`Ingresa ${attr.name.toLowerCase()}`} />
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {err && <div className="err"><span>⚠</span><span>{err}</span></div>}
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
            <div style={{fontSize:12,color:'var(--dim)'}}>Subiendo imagen y creando publicación</div>
          </div>
        )}

        {/* ── SUCCESS ── */}
        {screen === S.SUCCESS && result && (
          <>
            <div className="success">
              <div className="ok">✅</div>
              <div style={{fontSize:20,fontWeight:700}}>¡Publicado!</div>
              <div style={{fontSize:13,color:'var(--dim)'}}>ID: <code style={{fontFamily:'var(--mono)',color:'var(--y)'}}>{result.id}</code></div>
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

      </div>
    </>
  )
}
