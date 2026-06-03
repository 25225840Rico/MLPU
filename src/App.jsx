import { useState, useRef, useCallback, useEffect } from 'react'
import { analyzeProduct } from './agents/orchestrator.js'

const ML = 'https://api.mercadolibre.com'

const S = {
  ONBOARDING: 'onboarding',
  CAMERA: 'camera',
  PREVIEW: 'preview',
  ANALYZING: 'analyzing',
  CATEGORIES: 'categories',
  CONFIRM: 'confirm',
  PUBLISHING: 'publishing',
  SUCCESS: 'success'
}

// Scanner beep — dos tonos ascendentes tipo lector de código de barras
function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const now = ctx.currentTime
    ;[[880, 0, 0.12], [1320, 0.14, 0.14]].forEach(([freq, delay, dur]) => {
      const osc  = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0, now + delay)
      gain.gain.linearRampToValueAtTime(0.4, now + delay + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.001, now + delay + dur)
      osc.start(now + delay)
      osc.stop(now + delay + dur + 0.05)
    })
  } catch (_) {}
}

const css = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#06060a;--s1:#0e0e18;--s2:#16162a;--s3:#1e1e32;
  --brd:#28283e;--brd2:#38385a;
  --y:#ffe234;--g:#00d4a0;--r:#ff4f7b;--b:#3483fa;
  --txt:#e0e0f0;--dim:#5858a0;
  --mono:'JetBrains Mono',monospace;
}
body{background:var(--bg);color:var(--txt);font-family:'Space Grotesk',sans-serif;min-height:100dvh}
.app{max-width:430px;margin:0 auto;padding:16px 14px 72px;display:flex;flex-direction:column;gap:18px}

.top{display:flex;align-items:center;gap:8px;padding-bottom:14px;border-bottom:1px solid var(--brd)}
.logo{background:var(--y);color:#000;font-size:9px;font-weight:800;letter-spacing:2px;padding:4px 8px;border-radius:5px}
.top h1{font-size:16px;font-weight:700;flex:1}.top h1 em{color:var(--y);font-style:normal}
.cnt{font-size:11px;font-family:var(--mono);color:var(--dim);background:var(--s2);border:1px solid var(--brd);border-radius:20px;padding:3px 9px}

.card{background:var(--s2);border:1px solid var(--brd);border-radius:18px;padding:22px;display:flex;flex-direction:column;gap:14px}
.card h2{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:var(--dim)}

.f{display:flex;flex-direction:column;gap:5px}
.f label{font-size:10px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:1.2px}
.f input{background:var(--s1);border:1px solid var(--brd);border-radius:9px;color:var(--txt);font-family:var(--mono);font-size:12px;padding:11px 13px;outline:none;width:100%;transition:border-color .15s}
.f input:focus{border-color:var(--y)}
.f input::placeholder{color:var(--dim);opacity:.6}
.note{font-size:11px;color:var(--dim);background:var(--s3);border:1px solid var(--brd);border-radius:8px;padding:10px 13px;line-height:1.8}
.note code{color:var(--g);font-family:var(--mono);font-size:10px;word-break:break-all}

.btn{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:14px;border:none;border-radius:13px;cursor:pointer;padding:14px 20px;transition:all .1s;display:inline-flex;align-items:center;justify-content:center;gap:7px}
.btn:active{transform:scale(.96)}
.btn-y{background:var(--y);color:#000;width:100%;font-size:15px;padding:16px}
.btn-y:hover{background:#f0d400}
.btn-y:disabled{background:var(--brd);color:var(--dim);cursor:not-allowed;transform:none}
.btn-d{background:var(--s2);color:var(--txt);border:1px solid var(--brd);flex:1}
.btn-d:hover{border-color:var(--brd2)}
.row{display:flex;gap:10px}

.cam{position:relative;border-radius:20px;overflow:hidden;aspect-ratio:4/3;background:#000;border:1px solid var(--brd)}
.cam video,.cam img{width:100%;height:100%;object-fit:cover;display:block}
.cam-idle{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--dim)}
.cam-idle span{font-size:48px}
.cam-idle p{font-size:12px}
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
@keyframes spin{to{transform:rotate(360deg)}}
.agents{display:flex;flex-direction:column;gap:7px;width:100%;margin-top:4px}
.agent{display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--s3);border-radius:9px;font-size:12px;color:var(--dim)}
.agent .dot{width:6px;height:6px;border-radius:50%;background:var(--y);animation:blink .9s infinite;flex-shrink:0}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.1}}

.thumb{border-radius:14px;overflow:hidden;aspect-ratio:4/3;border:1px solid var(--brd)}
.thumb img{width:100%;height:100%;object-fit:cover}

.cat-list{display:flex;flex-direction:column;gap:8px}
.cat-item{background:var(--s2);border:1px solid var(--brd);border-radius:13px;padding:14px 16px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;transition:all .12s}
.cat-item:hover{border-color:var(--y);background:var(--s3)}
.cat-item.no-id{opacity:.6;cursor:not-allowed}
.cat-item.no-id:hover{border-color:var(--r)}
.cat-name{font-size:14px;font-weight:600}
.cat-id{font-size:11px;font-family:var(--mono);color:var(--dim);margin-top:2px}
.arrow{color:var(--y);font-size:16px}

.fields{display:flex;flex-direction:column;gap:11px}
.frow{display:flex;flex-direction:column;gap:3px}
.frow .lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--dim)}
.frow .val{font-size:14px;line-height:1.5}
.frow .val.big{font-size:21px;font-weight:700;color:var(--y)}
.badge{display:inline-flex;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700}
.badge.new{background:rgba(0,212,160,.12);color:var(--g);border:1px solid rgba(0,212,160,.25)}
.badge.used{background:rgba(255,226,52,.1);color:var(--y);border:1px solid rgba(255,226,52,.2)}
.cat-strip{display:flex;align-items:center;justify-content:space-between;background:var(--s3);border:1px solid var(--brd);border-radius:9px;padding:10px 13px}
.change{font-size:12px;color:var(--dim);cursor:pointer;text-decoration:underline}
.change:hover{color:var(--y)}

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
  const [appId,      setAppId]      = useState(() => LS.get('ml_app_id')      || '3829359465845583')
  const [token,      setToken]      = useState(() => LS.get('ml_token')        || '')
  const [tokenDraft, setTokenDraft] = useState(() => LS.get('ml_token')        || '')
  const [anthKey,    setAnthKey]    = useState(() => LS.get('anthropic_key')   || '')
  const [anthDraft,  setAnthDraft]  = useState(() => LS.get('anthropic_key')   || '')
  const [proxyUrl,   setProxyUrl]   = useState(() => LS.get('proxy_url')       || '')
  const [proxyDraft, setProxyDraft] = useState(() => LS.get('proxy_url')       || '')

  // ML API base: usa proxy para llamadas autenticadas si está configurado
  const mlBase = useCallback((path) => {
    if (proxyUrl) return `${proxyUrl.replace(/\/$/, '')}/ml${path}`
    return `${ML}${path}`
  }, [proxyUrl])

  const videoRef  = useRef(null)
  const canvasRef = useRef(null)
  const fileRef   = useRef(null)
  const [stream, setStream] = useState(null)
  const [img,    setImg]    = useState(null)

  const [analysis, setAnalysis]   = useState(null)
  const [cats,     setCats]       = useState([])
  const [selCat,   setSelCat]     = useState(null)
  const [result,   setResult]     = useState(null)
  const [err,      setErr]        = useState(null)
  const [count,    setCount]      = useState(0)

  // ── CAMERA
  const stopCam = useCallback(() => {
    if (stream) { stream.getTracks().forEach(t => t.stop()); setStream(null) }
  }, [stream])

  const startCam = useCallback(async () => {
    setErr(null)
    console.log('[cam] Solicitando acceso a cámara...')
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 } }
      })
      setStream(s); setImg(null); setScreen(S.CAMERA)
      setTimeout(() => {
        if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.play() }
      }, 80)
      console.log('[cam] Cámara activa')
    } catch (e) {
      console.error('[cam] Error:', e)
      setErr('Cámara no disponible: ' + e.message)
    }
  }, [])

  const capture = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return
    const v = videoRef.current, c = canvasRef.current
    c.width  = v.videoWidth  || 1280
    c.height = v.videoHeight || 720
    c.getContext('2d').drawImage(v, 0, 0)
    const b64 = c.toDataURL('image/jpeg', 0.92).split(',')[1]
    console.log('[cam] Captura OK — size aprox:', Math.round(b64.length / 1024), 'KB')
    setImg(b64)
    stopCam()
    setScreen(S.PREVIEW)
  }, [stopCam])

  const handleFile = e => {
    const f = e.target.files?.[0]; if (!f) return
    console.log('[file] Leyendo archivo:', f.name, Math.round(f.size / 1024), 'KB')
    const r = new FileReader()
    r.onload = ev => {
      setImg(ev.target.result.split(',')[1])
      stopCam()
      setScreen(S.PREVIEW)
    }
    r.readAsDataURL(f)
  }

  // ── ANALYZE
  const analyze = useCallback(async () => {
    if (!img) return
    setErr(null)
    setScreen(S.ANALYZING)
    console.log('[analyze] Iniciando análisis...')

    try {
      const a = await analyzeProduct(img, anthKey)
      setAnalysis(a)

      // Buscar categorías en ML
      console.log('[ml-cats] Buscando categorías para:', a.categorySearches)
      const found = [], seen = new Set()

      for (const q of (a.categorySearches || []).slice(0, 3)) {
        try {
          const url = `${ML}/sites/MLC/domain_discovery/search?q=${encodeURIComponent(q)}`
          console.log('[ml-cats] GET', url)
          const res  = await fetch(url)
          const data = await res.json()
          console.log('[ml-cats] Resultado para "' + q + '":', data)
          const items = Array.isArray(data) ? data : [data]
          for (const c of items.slice(0, 2)) {
            if (c?.category_id && !seen.has(c.category_id)) {
              seen.add(c.category_id)
              found.push({ id: c.category_id, name: c.category_name || q })
            }
          }
        } catch (e) {
          console.warn('[ml-cats] Error en búsqueda "' + q + '":', e.message)
        }
      }

      // Fallback: mostrar los términos como opciones manuales
      if (found.length === 0) {
        console.warn('[ml-cats] Sin resultados en ML API — usando fallback manual')
        ;(a.categorySearches || []).forEach((n, i) => {
          found.push({ id: '', name: n, manual: true })
        })
      }

      console.log('[ml-cats] Categorías finales:', found)
      setCats(found.slice(0, 5))

      // ── BEEP al completar análisis exitoso
      playBeep()

      setScreen(S.CATEGORIES)
    } catch (e) {
      console.error('[analyze] Error:', e)
      setErr('Error en análisis: ' + e.message)
      setScreen(S.PREVIEW)
    }
  }, [img, anthKey])

  // ── PUBLISH
  const publish = useCallback(async () => {
    if (!selCat || !analysis) return
    if (!selCat.id) {
      setErr('Esta categoría no tiene ID válido. Elige otra categoría.')
      return
    }
    setScreen(S.PUBLISHING)
    setErr(null)
    console.log('[publish] Iniciando publicación...', { selCat, analysis })

    try {
      // Subir imagen
      const pictures = []
      try {
        const blob = await (await fetch(`data:image/jpeg;base64,${img}`)).blob()
        const form = new FormData()
        form.append('file', blob, 'product.jpg')
        console.log('[publish] Subiendo imagen...')
        const pr = await fetch(mlBase('/pictures/items/upload'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form
        })
        if (pr.ok) {
          const pd = await pr.json()
          pictures.push({ id: pd.id })
          console.log('[publish] Imagen subida, id:', pd.id)
        } else {
          const perr = await pr.json()
          console.warn('[publish] Imagen no subida:', perr)
        }
      } catch (e) {
        console.warn('[publish] Error subiendo imagen (continuando sin foto):', e.message)
      }

      const description = [
        analysis.description,
        analysis.features?.length ? 'Características: ' + analysis.features.join(', ') + '.' : ''
      ].filter(Boolean).join(' ').trim() || analysis.title

      const payload = {
        title:              analysis.title,
        category_id:        selCat.id,
        price:              analysis.price,
        currency_id:        'CLP',
        available_quantity: 1,
        buying_mode:        'buy_it_now',
        condition:          analysis.condition,
        listing_type_id:    'gold_special',
        description:        { plain_text: description },
        ...(pictures.length && { pictures })
      }

      console.log('[publish] POST /items payload:', payload)
      const r    = await fetch(mlBase('/items'), {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload)
      })
      const data = await r.json()
      console.log('[publish] Respuesta ML:', data)

      if (!r.ok) throw new Error(data.message || JSON.stringify(data.cause || data))

      setResult(data)
      setCount(c => c + 1)
      playBeep()
      setScreen(S.SUCCESS)
    } catch (e) {
      console.error('[publish] Error:', e)
      setErr('Error publicando: ' + e.message)
      setScreen(S.CONFIRM)
    }
  }, [selCat, analysis, img, token, mlBase])

  const reset = () => {
    setImg(null); setAnalysis(null); setCats([])
    setSelCat(null); setResult(null); setErr(null)
    setScreen(S.CAMERA)
  }

  useEffect(() => () => stopCam(), [])

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
              <h2>Configuración inicial</h2>
              <div className="f">
                <label>App ID de MercadoLibre</label>
                <input value={appId} onChange={e => setAppId(e.target.value)} placeholder="3829359465845583" />
              </div>
              <hr />
              <div className="note">
                Para obtener el Access Token, abre este link en el navegador:<br/>
                <code>https://auth.mercadolibre.cl/authorization?response_type=code&client_id={appId}&redirect_uri=https://httpbin.org/get</code><br/><br/>
                Autoriza, copia el valor de <code>code</code> de la URL, y canjéalo con:<br/>
                <code>POST mercadolibre.com/oauth/token</code> con <code>grant_type=authorization_code</code>
              </div>
              <div className="f">
                <label>Access Token de MercadoLibre</label>
                <input
                  value={tokenDraft}
                  onChange={e => setTokenDraft(e.target.value)}
                  placeholder="APP_USR-..."
                  autoComplete="off"
                />
              </div>
              <hr />
              <div className="f">
                <label>Anthropic API Key</label>
                <input
                  type="password"
                  value={anthDraft}
                  onChange={e => setAnthDraft(e.target.value)}
                  placeholder="sk-ant-api03-..."
                  autoComplete="off"
                />
              </div>
              <hr />
              <div className="f">
                <label>Proxy URL <span style={{color:'var(--g)',fontSize:9}}>(requerido para publicar)</span></label>
                <input
                  value={proxyDraft}
                  onChange={e => setProxyDraft(e.target.value)}
                  placeholder="https://mlpu-proxy.TU-USUARIO.workers.dev"
                  autoComplete="off"
                />
              </div>
              <div className="note">
                Las claves se guardan solo en tu navegador (<code>localStorage</code>). El proxy es necesario para publicar en MercadoLibre — ver instrucciones en el repo.
              </div>
            </div>
            <button
              className="btn btn-y"
              disabled={!appId || !tokenDraft || !anthDraft}
              onClick={() => {
                LS.set('ml_app_id',     appId)
                LS.set('ml_token',      tokenDraft)
                LS.set('anthropic_key', anthDraft)
                LS.set('proxy_url',     proxyDraft)
                setToken(tokenDraft)
                setAnthKey(anthDraft)
                setProxyUrl(proxyDraft)
                setScreen(S.CAMERA)
              }}
            >
              Comenzar →
            </button>
          </>
        )}

        {/* ── CAMERA ── */}
        {screen === S.CAMERA && (
          <>
            <div className="cam">
              {stream && <video ref={videoRef} autoPlay playsInline muted />}
              {stream && (
                <><div className="corner tl"/><div className="corner tr"/>
                  <div className="corner bl"/><div className="corner br"/></>
              )}
              {!stream && (
                <div className="cam-idle">
                  <span>📷</span>
                  <p>Toca para activar la cámara</p>
                </div>
              )}
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
                  <div className="shutter" onClick={capture}>
                    <div className="shutter-inner"/>
                  </div>
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
              {[
                '👁  Visión — identificando producto y marca',
                '📝  SEO — optimizando título (60 chars)',
                '💰  Precio — estimando valor en CLP',
                '🏷️  Categoría — buscando en MercadoLibre'
              ].map((t, i) => (
                <div key={i} className="agent">
                  <span className="dot"/>
                  {t}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── CATEGORIES ── */}
        {screen === S.CATEGORIES && analysis && (
          <>
            <div className="thumb">
              <img src={`data:image/jpeg;base64,${img}`} alt="producto"/>
            </div>
            <div>
              <div style={{fontSize:15,fontWeight:700,marginBottom:4,lineHeight:1.3}}>{analysis.title}</div>
              {analysis.brand && (
                <div style={{fontSize:12,color:'var(--dim)',marginBottom:4}}>
                  {analysis.brand}{analysis.model ? ` · ${analysis.model}` : ''}
                </div>
              )}
              <div style={{fontSize:22,fontWeight:700,color:'var(--y)',marginBottom:12}}>
                ${analysis.price?.toLocaleString('es-CL')} CLP
              </div>
              <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'2px',color:'var(--dim)',marginBottom:8}}>
                Selecciona la categoría
              </div>
            </div>
            <div className="cat-list">
              {cats.length > 0 ? cats.map((c, i) => (
                <div
                  key={i}
                  className={`cat-item${c.manual || !c.id ? ' no-id' : ''}`}
                  onClick={() => {
                    if (!c.id) { setErr('Esta categoría no tiene ID. Elige otra o ingresa el ID manualmente.'); return }
                    setErr(null); setSelCat(c); setScreen(S.CONFIRM)
                  }}
                >
                  <div>
                    <div className="cat-name">{c.name}</div>
                    {c.id
                      ? <div className="cat-id">{c.id}</div>
                      : <div className="cat-id" style={{color:'var(--r)'}}>Sin ID — no publicable</div>
                    }
                  </div>
                  <span className="arrow">{c.id ? '→' : '✕'}</span>
                </div>
              )) : (
                <div style={{textAlign:'center',color:'var(--dim)',padding:20,fontSize:13,background:'var(--s2)',borderRadius:12,border:'1px solid var(--brd)'}}>
                  No se encontraron categorías en ML API
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
            <div style={{display:'flex',flexDirection:'column',gap:14}}>
              <div className="thumb">
                <img src={`data:image/jpeg;base64,${img}`} alt="producto"/>
              </div>
              <div className="fields">
                <div className="frow">
                  <span className="lbl">Título</span>
                  <span className="val">{analysis.title}</span>
                </div>
                {analysis.description && (
                  <div className="frow">
                    <span className="lbl">Descripción</span>
                    <span className="val" style={{fontSize:12,color:'var(--dim)',lineHeight:1.6}}>{analysis.description}</span>
                  </div>
                )}
                <div style={{display:'flex',gap:20,alignItems:'flex-end'}}>
                  <div className="frow">
                    <span className="lbl">Precio</span>
                    <span className="val big">${analysis.price?.toLocaleString('es-CL')}</span>
                  </div>
                  <div className="frow">
                    <span className="lbl">Estado</span>
                    <span className={`badge ${analysis.condition}`}>
                      {analysis.condition === 'new' ? 'Nuevo' : 'Usado'}
                    </span>
                  </div>
                </div>
                <div className="frow">
                  <span className="lbl">Categoría</span>
                  <div className="cat-strip">
                    <div>
                      <div style={{fontSize:14,fontWeight:600}}>{selCat.name}</div>
                      <div style={{fontSize:11,fontFamily:'var(--mono)',color:'var(--dim)'}}>{selCat.id}</div>
                    </div>
                    <span className="change" onClick={() => setScreen(S.CATEGORIES)}>Cambiar</span>
                  </div>
                </div>
              </div>
              {err && <div className="err"><span>⚠</span><span>{err}</span></div>}
              <button className="btn btn-y" onClick={publish}>🚀 Publicar en MercadoLibre</button>
              <button className="btn btn-d" style={{width:'100%'}} onClick={() => setScreen(S.CATEGORIES)}>← Categoría</button>
            </div>
          </>
        )}

        {/* ── PUBLISHING ── */}
        {screen === S.PUBLISHING && (
          <div className="loader">
            <div className="ring"/>
            <div style={{fontSize:16,fontWeight:700}}>Publicando…</div>
            <div style={{fontSize:12,color:'var(--dim)'}}>Subiendo imagen y creando publicación en ML</div>
          </div>
        )}

        {/* ── SUCCESS ── */}
        {screen === S.SUCCESS && result && (
          <>
            <div className="success">
              <div className="ok">✅</div>
              <div style={{fontSize:20,fontWeight:700}}>¡Publicado!</div>
              <div style={{fontSize:13,color:'var(--dim)'}}>
                ID: <code style={{fontFamily:'var(--mono)',color:'var(--y)'}}>{result.id}</code>
              </div>
              {result.permalink && (
                <div className="pub-link">
                  <a href={result.permalink} target="_blank" rel="noopener noreferrer">
                    {result.permalink}
                  </a>
                </div>
              )}
            </div>
            <button className="btn btn-y" onClick={reset}>📷 Publicar otro producto</button>
            <button className="btn btn-d" style={{width:'100%'}} onClick={() => setScreen(S.ONBOARDING)}>
              ⚙ Cambiar token
            </button>
          </>
        )}

      </div>
    </>
  )
}
