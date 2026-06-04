import { useState, useRef, useEffect, useCallback } from 'react'

const MIN_SIZE = 60
const HANDLE = 28 // touch handle size in px

export default function CropScreen({ imgB64, onCrop, onSkip }) {
  const containerRef = useRef(null)
  const imgElRef     = useRef(null)
  const canvasRef    = useRef(null)

  const [ready,   setReady]   = useState(false)
  const [natural, setNatural] = useState({ w: 0, h: 0 })
  const [box,     setBox]     = useState({ x: 0, y: 0, w: 0, h: 0 }) // display coords
  const [layout,  setLayout]  = useState({ imgX: 0, imgY: 0, imgW: 0, imgH: 0 }) // image-on-screen rect
  const [aspect,  setAspect]  = useState('1:1') // '1:1' | '4:3' | '3:4' | 'free'

  const dragRef = useRef(null) // { type, startPX, startPY, startBox }

  // ── load natural dimensions
  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      setNatural({ w: img.width, h: img.height })
      imgElRef.current = img
    }
    img.src = 'data:image/jpeg;base64,' + imgB64
  }, [imgB64])

  // ── compute layout & default crop box once image and container are ready
  const computeLayout = useCallback((natW, natH, containerEl, asp) => {
    if (!natW || !containerEl) return
    const cW = containerEl.clientWidth
    const cH = containerEl.clientHeight
    const scale = Math.min(cW / natW, cH / natH)
    const imgW  = natW * scale
    const imgH  = natH * scale
    const imgX  = (cW - imgW) / 2
    const imgY  = (cH - imgH) / 2
    const lay   = { imgX, imgY, imgW, imgH, scale }
    setLayout(lay)

    // default crop = centered, honoring aspect
    const [ar, ab] = asp === 'free' ? [1, 1] : asp.split(':').map(Number)
    const maxW = imgW
    const maxH = imgH
    let bw, bh
    if (maxW / ar * ab <= maxH) { bw = maxW; bh = bw / ar * ab }
    else                         { bh = maxH; bw = bh / ab * ar }
    setBox({ x: imgX + (imgW - bw) / 2, y: imgY + (imgH - bh) / 2, w: bw, h: bh })
    return lay
  }, [])

  useEffect(() => {
    if (!natural.w || !containerRef.current) return
    setReady(true)
    computeLayout(natural.w, natural.h, containerRef.current, aspect)
  }, [natural, computeLayout, aspect])

  // recompute on aspect change (keep center)
  const changeAspect = (asp) => {
    setAspect(asp)
    if (!natural.w || !containerRef.current) return
    computeLayout(natural.w, natural.h, containerRef.current, asp)
  }

  // ── clamp box within image bounds
  const clamp = useCallback((b, lay) => {
    const { imgX, imgY, imgW, imgH } = lay || layout
    let { x, y, w, h } = b
    w = Math.max(MIN_SIZE, Math.min(w, imgW))
    h = Math.max(MIN_SIZE, Math.min(h, imgH))
    x = Math.max(imgX, Math.min(x, imgX + imgW - w))
    y = Math.max(imgY, Math.min(y, imgY + imgH - h))
    return { x, y, w, h }
  }, [layout])

  // ── pointer events
  const onPointerDown = useCallback((e, type) => {
    e.stopPropagation()
    dragRef.current = {
      type,
      startPX: e.clientX, startPY: e.clientY,
      startBox: { ...box }
    }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }, [box])

  const onPointerMove = useCallback((e) => {
    if (!dragRef.current) return
    const { type, startPX, startPY, startBox: s } = dragRef.current
    const dx = e.clientX - startPX
    const dy = e.clientY - startPY

    setBox(prev => {
      let nb = { ...prev }
      if (type === 'move') {
        nb.x = s.x + dx; nb.y = s.y + dy
      } else {
        // resize from corners
        if (type.includes('r')) { nb.w = Math.max(MIN_SIZE, s.w + dx) }
        if (type.includes('l')) { nb.x = s.x + dx; nb.w = Math.max(MIN_SIZE, s.w - dx) }
        if (type.includes('b')) { nb.h = Math.max(MIN_SIZE, s.h + dy) }
        if (type.includes('t')) { nb.y = s.y + dy; nb.h = Math.max(MIN_SIZE, s.h - dy) }
        // lock aspect ratio unless free
        if (aspect !== 'free') {
          const [ar, ab] = aspect.split(':').map(Number)
          if (type.includes('r') || type.includes('l')) nb.h = nb.w / ar * ab
          else nb.w = nb.h / ab * ar
        }
      }
      return clamp(nb, layout)
    })
  }, [clamp, layout, aspect])

  const onPointerUp = useCallback(() => { dragRef.current = null }, [])

  // ── confirm: draw crop to canvas
  const handleConfirm = useCallback(() => {
    if (!imgElRef.current || !canvasRef.current || !layout.scale) return
    const { imgX, imgY, scale } = layout
    const natX = (box.x - imgX) / scale
    const natY = (box.y - imgY) / scale
    const natW = box.w / scale
    const natH = box.h / scale
    const c = canvasRef.current
    c.width  = Math.round(natW)
    c.height = Math.round(natH)
    c.getContext('2d').drawImage(
      imgElRef.current,
      Math.round(natX), Math.round(natY), Math.round(natW), Math.round(natH),
      0, 0, Math.round(natW), Math.round(natH)
    )
    const b64 = c.toDataURL('image/jpeg', 0.92).split(',')[1]
    onCrop(b64)
  }, [box, layout, onCrop])

  // ── ML preview: how the crop looks in a square ML frame
  const [showML, setShowML] = useState(false)

  // ── styles
  const S = {
    wrap: {
      position: 'fixed', inset: 0, zIndex: 9998,
      background: '#000', display: 'flex', flexDirection: 'column',
    },
    imgArea: {
      flex: 1, position: 'relative', overflow: 'hidden',
      touchAction: 'none', userSelect: 'none',
    },
    img: {
      position: 'absolute',
      left: layout.imgX, top: layout.imgY,
      width: layout.imgW, height: layout.imgH,
      pointerEvents: 'none',
    },
    // dark mask = 4 rects around the crop box
    maskTop: {
      position: 'absolute', left: 0, top: 0,
      width: '100%', height: box.y,
      background: 'rgba(0,0,0,.55)', pointerEvents: 'none',
    },
    maskBottom: {
      position: 'absolute', left: 0, top: box.y + box.h,
      width: '100%', bottom: 0, height: `calc(100% - ${box.y + box.h}px)`,
      background: 'rgba(0,0,0,.55)', pointerEvents: 'none',
    },
    maskLeft: {
      position: 'absolute', left: 0, top: box.y,
      width: box.x, height: box.h,
      background: 'rgba(0,0,0,.55)', pointerEvents: 'none',
    },
    maskRight: {
      position: 'absolute', left: box.x + box.w, top: box.y,
      width: `calc(100% - ${box.x + box.w}px)`, height: box.h,
      background: 'rgba(0,0,0,.55)', pointerEvents: 'none',
    },
    cropBorder: {
      position: 'absolute',
      left: box.x, top: box.y, width: box.w, height: box.h,
      border: '2px solid rgba(255,255,255,.9)',
      boxSizing: 'border-box', cursor: 'move',
    },
    grid: {
      position: 'absolute', inset: 0, pointerEvents: 'none',
      backgroundImage: 'linear-gradient(rgba(255,255,255,.15) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.15) 1px,transparent 1px)',
      backgroundSize: `${box.w/3}px ${box.h/3}px`,
    },
    handle: (pos) => {
      const half = HANDLE / 2
      const map = {
        tl: { left: -half, top: -half },
        tr: { right: -half, top: -half },
        bl: { left: -half, bottom: -half },
        br: { right: -half, bottom: -half },
      }
      return {
        position: 'absolute', ...map[pos],
        width: HANDLE, height: HANDLE,
        background: '#fff', borderRadius: 4,
        cursor: pos === 'tl' || pos === 'br' ? 'nwse-resize' : 'nesw-resize',
        touchAction: 'none',
      }
    },
    bottomBar: {
      background: '#111', padding: '10px 14px',
      paddingBottom: 'max(10px,env(safe-area-inset-bottom))',
      display: 'flex', flexDirection: 'column', gap: 10,
    },
    aspectRow: {
      display: 'flex', gap: 8, justifyContent: 'center',
    },
    aspBtn: (active) => ({
      padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
      fontSize: 13, fontWeight: 600,
      background: active ? '#2563eb' : '#333', color: active ? '#fff' : '#aaa',
    }),
    actionRow: {
      display: 'flex', gap: 10,
    },
    skipBtn: {
      flex: 1, padding: '12px', borderRadius: 10, border: 'none',
      background: '#333', color: '#ccc', fontSize: 14, fontWeight: 600, cursor: 'pointer',
    },
    confirmBtn: {
      flex: 2, padding: '12px', borderRadius: 10, border: 'none',
      background: '#2563eb', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer',
    },
    mlPreviewOverlay: {
      position: 'fixed', inset: 0, zIndex: 10000,
      background: 'rgba(0,0,0,.85)', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24,
    },
    mlCard: {
      background: '#fff', borderRadius: 12, overflow: 'hidden',
      width: 260, boxShadow: '0 8px 32px rgba(0,0,0,.5)',
    },
    mlImg: { width: '100%', aspectRatio: '1/1', objectFit: 'cover', display: 'block' },
    mlMeta: { padding: '10px 12px' },
  }

  const cropDataURL = ready && imgElRef.current
    ? (() => {
        try {
          const c = document.createElement('canvas')
          const { imgX, imgY, scale } = layout
          const nW = Math.round(box.w / scale), nH = Math.round(box.h / scale)
          c.width = nW; c.height = nH
          c.getContext('2d').drawImage(
            imgElRef.current,
            Math.round((box.x - imgX) / scale), Math.round((box.y - imgY) / scale), nW, nH,
            0, 0, nW, nH
          )
          return c.toDataURL('image/jpeg', 0.85)
        } catch { return null }
      })()
    : null

  const dimLabel = ready
    ? `${Math.round(box.w / (layout.scale || 1))} × ${Math.round(box.h / (layout.scale || 1))} px`
    : ''

  return (
    <div style={S.wrap}>
      {/* image + crop overlay */}
      <div
        ref={containerRef}
        style={S.imgArea}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {ready && (
          <>
            <img
              src={`data:image/jpeg;base64,${imgB64}`}
              alt=""
              style={S.img}
              draggable={false}
            />
            {/* masks */}
            <div style={S.maskTop} />
            <div style={S.maskBottom} />
            <div style={S.maskLeft} />
            <div style={S.maskRight} />
            {/* crop border + grid + handles */}
            <div
              style={S.cropBorder}
              onPointerDown={e => onPointerDown(e, 'move')}
            >
              <div style={S.grid} />
              {['tl','tr','bl','br'].map(h => (
                <div
                  key={h}
                  style={S.handle(h)}
                  onPointerDown={e => onPointerDown(e, h)}
                />
              ))}
            </div>
          </>
        )}
        {!ready && (
          <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',color:'#fff'}}>
            Cargando…
          </div>
        )}
      </div>

      {/* controls */}
      <div style={S.bottomBar}>
        <div style={S.aspectRow}>
          {[['1:1','□'],['4:3','▭'],['3:4','▯'],['free','✂']].map(([val,lbl]) => (
            <button key={val} style={S.aspBtn(aspect === val)} onClick={() => changeAspect(val)}>
              {lbl} {val}
            </button>
          ))}
        </div>
        <div style={{textAlign:'center',color:'#666',fontSize:11}}>{dimLabel}</div>
        <div style={S.actionRow}>
          <button style={S.skipBtn} onClick={onSkip}>Omitir</button>
          {cropDataURL && (
            <button
              style={{...S.skipBtn, background:'#1a1a2e', color:'#7ca9f8'}}
              onClick={() => setShowML(true)}
            >
              Ver en ML
            </button>
          )}
          <button style={S.confirmBtn} onClick={handleConfirm}>✓ Recortar</button>
        </div>
      </div>

      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* ML preview modal */}
      {showML && cropDataURL && (
        <div style={S.mlPreviewOverlay} onClick={() => setShowML(false)}>
          <div style={{color:'#fff',fontSize:13,opacity:.7}}>Vista previa en MercadoLibre — toca para cerrar</div>
          <div style={S.mlCard}>
            <img src={cropDataURL} alt="preview" style={S.mlImg} />
            <div style={S.mlMeta}>
              <div style={{fontSize:13,fontWeight:700,color:'#333',marginBottom:4}}>Nombre del producto</div>
              <div style={{fontSize:15,fontWeight:800,color:'#3483fa'}}>$ 15.000</div>
              <div style={{fontSize:11,color:'#999',marginTop:2}}>Envío gratis · Nuevo</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
