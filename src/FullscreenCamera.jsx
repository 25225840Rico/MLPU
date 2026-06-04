import { useState, useRef, useEffect, useCallback } from 'react'

export default function FullscreenCamera({ onPhotoCaptured, onClose }) {
  const [visible, setVisible]       = useState(false)  // drives slide animation
  const [closing, setClosing]       = useState(false)
  const [flash, setFlash]           = useState(false)
  const [facingMode, setFacingMode] = useState('environment')
  const [permError, setPermError]   = useState(null)

  const videoRef  = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }, [])

  const startStream = useCallback(async (facing) => {
    stopStream()
    setPermError(null)
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, height: { ideal: 1920 }, aspectRatio: { ideal: 3 / 4 } },
        audio: false,
      })
      streamRef.current = s
      if (videoRef.current) {
        videoRef.current.srcObject = s
        await videoRef.current.play().catch(() => {})
      }
    } catch (e) {
      setPermError(e.name === 'NotAllowedError'
        ? 'Permiso de cámara denegado. Habilítalo en la configuración del navegador.'
        : 'No se pudo acceder a la cámara: ' + e.message)
    }
  }, [stopStream])

  // Mount: slide in, then start camera
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true))
    startStream(facingMode)
    return () => cancelAnimationFrame(raf)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-attach stream to video element whenever it becomes available
  useEffect(() => {
    if (videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current
      videoRef.current.play().catch(() => {})
    }
  })

  const flipCamera = useCallback(() => {
    const next = facingMode === 'environment' ? 'user' : 'environment'
    setFacingMode(next)
    startStream(next)
  }, [facingMode, startStream])

  const animateClose = useCallback((then) => {
    setClosing(true)
    setVisible(false)
    setTimeout(() => { stopStream(); then() }, 260)
  }, [stopStream])

  const handleClose = useCallback(() => {
    animateClose(onClose)
  }, [animateClose, onClose])

  const handleCapture = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return
    const v = videoRef.current
    const c = canvasRef.current
    c.width  = v.videoWidth  || 960
    c.height = v.videoHeight || 1280
    c.getContext('2d').drawImage(v, 0, 0)
    const dataURL = c.toDataURL('image/jpeg', 0.9)

    // flash then close
    setFlash(true)
    setTimeout(() => setFlash(false), 150)
    setTimeout(() => animateClose(() => onPhotoCaptured(dataURL)), 80)
  }, [animateClose, onPhotoCaptured])

  // ── styles (all inline, no external CSS)
  const overlay = {
    position: 'fixed',
    inset: 0,
    zIndex: 9999,
    background: '#000',
    display: 'flex',
    flexDirection: 'column',
    transform: visible ? 'translateY(0)' : 'translateY(100%)',
    transition: closing
      ? 'transform 250ms ease-in'
      : 'transform 300ms ease-out',
    willChange: 'transform',
  }

  const video = {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  }

  const flashOverlay = {
    position: 'absolute',
    inset: 0,
    background: '#fff',
    opacity: flash ? 0.8 : 0,
    transition: flash ? 'opacity 75ms ease-out' : 'opacity 150ms ease-in',
    pointerEvents: 'none',
    zIndex: 2,
  }

  const topBar = {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    padding: '16px 16px',
    paddingTop: 'max(16px, env(safe-area-inset-top))',
    display: 'flex',
    justifyContent: 'flex-end',
    zIndex: 3,
  }

  const closeBtn = {
    width: 36,
    height: 36,
    borderRadius: '50%',
    background: 'rgba(0,0,0,0.45)',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    fontSize: 18,
    lineHeight: 1,
    WebkitTapHighlightColor: 'transparent',
    touchAction: 'manipulation',
  }

  const bottomBar = {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: 'max(32px, env(safe-area-inset-bottom))',
    paddingLeft: 32,
    paddingRight: 32,
    paddingTop: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 3,
  }

  const flipBtn = {
    width: 44,
    height: 44,
    borderRadius: '50%',
    background: 'rgba(0,0,0,0.45)',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 22,
    WebkitTapHighlightColor: 'transparent',
    touchAction: 'manipulation',
  }

  const shutterOuter = {
    width: 88,
    height: 88,
    borderRadius: '50%',
    border: '3px solid rgba(255,255,255,0.85)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
    touchAction: 'manipulation',
  }

  const shutterInner = {
    width: 68,
    height: 68,
    borderRadius: '50%',
    background: '#fff',
    transition: 'transform 80ms',
    activeTransform: 'scale(0.88)',
  }

  const errBox = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    zIndex: 3,
  }

  const errMsg = {
    background: 'rgba(0,0,0,0.75)',
    color: '#fff',
    borderRadius: 14,
    padding: '20px 24px',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 1.5,
    maxWidth: 320,
  }

  return (
    <div style={overlay}>
      {/* live preview */}
      <video ref={videoRef} style={video} autoPlay playsInline muted />

      {/* capture flash */}
      <div style={flashOverlay} />

      {/* permission error */}
      {permError && (
        <div style={errBox}>
          <div style={errMsg}>{permError}</div>
        </div>
      )}

      {/* top bar: close button */}
      <div style={topBar}>
        <button style={closeBtn} onClick={handleClose} aria-label="Cerrar">✕</button>
      </div>

      {/* bottom bar: flip | shutter | spacer */}
      <div style={bottomBar}>
        <button style={flipBtn} onClick={flipCamera} aria-label="Girar cámara">🔄</button>

        <div style={shutterOuter} onClick={handleCapture} aria-label="Capturar">
          <div style={shutterInner} />
        </div>

        {/* spacer to balance flip button */}
        <div style={{ width: 44 }} />
      </div>

      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  )
}
