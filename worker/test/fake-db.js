// FakeDB: imita el subset de la API de D1 que usan ig-api.js e ig-queue.js.
// Soporta las queries por texto (match por fragmento), suficiente para unit tests.
export class FakeDB {
  constructor() { this.config = new Map(); this.queue = []; this.nextId = 1 }

  async seedConfig(clave, valor) { this.config.set(clave, valor) }
  async getConfig(clave) { return this.config.get(clave) }
  seedQueue(row) {
    const r = { id: this.nextId++, estado: 'pendiente', intentos: 0, ultimo_error: null,
      ig_media_id: null, ig_story_id: null, publicado_en: null, prioridad: 0, ...row }
    this.queue.push(r); return r
  }

  prepare(sql) { return makeStmt(this, sql, []) }

  // D1 corre el batch dentro de una transaccion: si una sentencia falla, hace
  // ROLLBACK del lote entero. El fake ejecutaba en serie y dejaba a medias los
  // cambios ya aplicados. Aca: snapshot antes, restore si algo lanza, y re-lanza.
  async batch(stmts) {
    const snap = {
      queue: this.queue.map(r => ({ ...r })),
      config: new Map(this.config),
      nextId: this.nextId,
    }
    const out = []
    try {
      for (const s of stmts) out.push(await s.run())
      return out
    } catch (e) {
      const vivos = new Map(this.queue.map(r => [r.id, r]))
      this.queue = snap.queue.map(s => {
        const r = vivos.get(s.id)
        if (!r) return s                                   // fila creada por el lote
        for (const k of Object.keys(r)) if (!(k in s)) delete r[k]
        return Object.assign(r, s)                         // conserva la identidad
      })
      this.config = snap.config
      this.nextId = snap.nextId
      throw e
    }
  }
}

// Tripwire: el doble NUNCA debe devolver exito ante una SQL que no entiende.
// Antes caia a `{success:true}` / `{results:[]}` / `null` y tapaba typos de tabla,
// DELETEs que no borraban y SELECTs a tablas inexistentes.
const sqlNoSoportada = sql =>
  new Error('SQL no soportada por FakeDB: ' + String(sql).replace(/\s+/g, ' ').trim())

// El foco de fuente viaja interpolado en el SQL (`AND fuente='drive'`), no como bind.
const focoDe = sql => (sql.match(/fuente='(\w+)'/) || [])[1] || null

// D1 solo acepta null, number, string y ArrayBuffer como parametros; ante
// undefined, booleanos, objetos o funciones responde D1_TYPE_ERROR. El fake lo
// aceptaba todo y tapaba errores de tipo reales.
function chequearTipo(v) {
  if (v === null) return v
  const t = typeof v
  if (t === 'string' || t === 'number') return v
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return v
  throw new Error(`D1_TYPE_ERROR: valor no soportado en bind(): ${t === 'undefined' ? 'undefined' : t}`)
}

function makeStmt(db, sql, args) {
  const run = async () => {
    let changes = 0
    if (sql.includes('ON CONFLICT(ml_item_id)')) {
      const [ml_item_id, titulo, precio, permalink_ml] = args
      const row = db.queue.find(r => r.ml_item_id === ml_item_id)
      if (!row) { db.seedQueue({ ml_item_id, titulo, precio, permalink_ml, creado_en: new Date().toISOString() }); changes = 1 }
      else if (row.estado === 'cancelado') { Object.assign(row, { estado: 'pendiente', intentos: 0, ultimo_error: null, titulo, precio, permalink_ml }); changes = 1 }
      return { success: true, meta: { changes } }
    } else if (sql.includes('INSERT OR IGNORE INTO ig_queue')) {
      const [ml_item_id, titulo, precio, permalink_ml] = args
      if (!db.queue.some(r => r.ml_item_id === ml_item_id)) {
        db.seedQueue({ ml_item_id, titulo, precio, permalink_ml, creado_en: new Date().toISOString() })
        changes = 1
      }
    } else if (sql.includes('REPLACE INTO ig_config')) {
      db.config.set(args[0], args[1]); changes = 1
    } else if (sql.includes('DELETE FROM ig_config')) {
      const clave = sql.match(/clave='([^']+)'/)?.[1] ?? args[0]
      changes = db.config.delete(clave) ? 1 : 0
    } else if (sql.includes('UPDATE ig_queue') && sql.includes("SET estado='cancelado'") && sql.includes("WHERE estado='pendiente'") && !args.length) {
      // vaciarCola: cancela las pendientes; honra el filtro de fuente si viene interpolado
      const foco = focoDe(sql)
      for (const r of db.queue)
        if (r.estado === 'pendiente' && (!foco || (r.fuente || 'ml') === foco)) { r.estado = 'cancelado'; changes++ }
    } else if (sql.includes('UPDATE ig_queue') && sql.includes("WHERE estado='error'")) {
      // reintentarErrores: las filas muertas vuelven a la cola con los intentos
      // en cero. ig_media_id/ig_story_id NO se tocan (idempotencia del feed).
      const foco = focoDe(sql)
      for (const r of db.queue)
        if (r.estado === 'error' && (!foco || (r.fuente || 'ml') === foco)) {
          Object.assign(r, { estado: 'pendiente', intentos: 0, ultimo_error: null }); changes++
        }
    } else if (sql.includes('UPDATE ig_queue') && sql.includes("WHERE estado='publicando'")) {
      // recoverStuck ('pendiente') y vaciarCola de colgadas / B14 ('cancelado').
      const nuevo = sql.includes("SET estado='cancelado'") ? 'cancelado' : 'pendiente'
      // Umbral = RECOVERY_MIN de worker/ig-queue.js (CONTRATO 4.1): 10 min, no 15.
      const limite = Date.now() - 10 * 60 * 1000
      // Semantica de SQLite: `NULL < x` evalua a NULL, no a true, asi que una fila
      // con claimed_en NULL NUNCA entra en el WHERE... salvo que el SQL traiga
      // explicitamente `claimed_en IS NULL` (el fix #9 que aplicara L1).
      const tomaNull = sql.includes('claimed_en IS NULL')
      for (const r of db.queue) {
        if (r.estado !== 'publicando') continue
        const alcanzada = r.claimed_en == null ? tomaNull : Date.parse(r.claimed_en) < limite
        if (alcanzada) { r.estado = nuevo; changes++ }
      }
    } else if (sql.includes('UPDATE ig_queue') && /WHERE id=\?/.test(sql)) {
      const id = args[args.length - 1]
      const row = db.queue.find(r => r.id === id)
      if (row) {
        changes = 1
        if (sql.includes("estado='publicado'")) {
          Object.assign(row, { estado: 'publicado', ultimo_error: args[0] ?? null, publicado_en: new Date().toISOString() })
        } else if (sql.includes('prioridad=?')) {
          // requeueStories: vuelve a pendiente para solo-historia
          Object.assign(row, { estado: 'pendiente', intentos: 0, ultimo_error: null, ig_story_id: null, prioridad: args[0] })
        } else if (sql.includes('SET ig_story_id=NULL')) {
          row.ig_story_id = null
        } else if (sql.includes('SET ig_media_id=?')) {
          row.ig_media_id = args[0]
        } else if (sql.includes('SET ig_story_id=?')) {
          row.ig_story_id = args[0]
        } else if (sql.includes('CASE WHEN intentos>=')) {
          row.ultimo_error = args[0]
          row.estado = row.intentos >= 3 ? 'error' : 'pendiente'
        } else if (sql.includes("estado='cancelado'")) {
          if (sql.includes("estado='pendiente'") && row.estado !== 'pendiente') changes = 0
          else row.estado = 'cancelado'
        } else throw sqlNoSoportada(sql)
      }
    } else throw sqlNoSoportada(sql)
    return { success: true, meta: { changes } }
  }
  const all = async () => {
    // Panel de /ig (telegram-bot.js): SELECT estado, COUNT(*) n ... GROUP BY estado
    if (sql.includes('GROUP BY estado')) {
      const estados = [...(sql.match(/estado IN \(([^)]*)\)/)?.[1].matchAll(/'([^']+)'/g) || [])].map(m => m[1])
      const n = new Map()
      for (const r of db.queue)
        if (!estados.length || estados.includes(r.estado)) n.set(r.estado, (n.get(r.estado) || 0) + 1)
      return { results: [...n].map(([estado, c]) => ({ estado, n: c })) }
    }
    // Panel de /ig: SELECT COALESCE(fuente,'ml') f, COUNT(*) n ... GROUP BY 1
    if (sql.includes("COALESCE(fuente,'ml')") && sql.includes('GROUP BY 1')) {
      const n = new Map()
      for (const r of db.queue)
        if (r.estado === 'pendiente') { const f = r.fuente || 'ml'; n.set(f, (n.get(f) || 0) + 1) }
      return { results: [...n].map(([f, c]) => ({ f, n: c })) }
    }
    if (sql.includes('FROM ig_queue')) {
      let rows
      if (sql.includes("estado='publicado'") && sql.includes('ig_media_id IS NOT NULL')) {
        rows = db.queue.filter(r => r.estado === 'publicado' && r.ig_media_id)
      } else if (sql.includes('ig_story_id IS NOT NULL')) {
        // historias vivas: publicadas hace menos de 24 h
        const desde = Date.now() - 24 * 3600e3
        rows = db.queue.filter(r => r.ig_story_id && r.publicado_en && Date.parse(r.publicado_en) > desde)
      } else {
        // listPendientes, con filtro de fuente opcional (CONTRATO 4.2 #3)
        const foco = focoDe(sql)
        rows = db.queue.filter(r => r.estado === 'pendiente' && (!foco || (r.fuente || 'ml') === foco))
      }
      const m = sql.match(/LIMIT (\d+)/)
      if (m) rows = rows.slice(0, Number(m[1]))
      return { results: rows }
    }
    throw sqlNoSoportada(sql)
  }
  const first = async () => {
    if (sql.includes('MAX(publicado_en)')) {
      const fechas = db.queue.map(r => r.publicado_en).filter(Boolean).sort()
      return { m: fechas[fechas.length - 1] ?? null }
    }
    if (sql.includes('MIN(publicado_en)')) {
      const desde = Date.now() - 24 * 3600e3
      const fechas = db.queue.map(r => r.publicado_en).filter(f => f && Date.parse(f) > desde).sort()
      return { m: fechas[0] ?? null }
    }
    if (sql.includes('COUNT(*)') && sql.includes("estado='pendiente'")) {
      const foco = focoDe(sql)   // filtro /ig solo
      return { n: db.queue.filter(r => r.estado === 'pendiente' && (!foco || (r.fuente || 'ml') === foco)).length }
    }
    if (sql.includes('COUNT(*)') && sql.includes('ig_story_id IS NOT NULL')) {
      const desde = Date.now() - 24 * 3600e3
      return { n: db.queue.filter(r => r.ig_story_id && r.publicado_en && Date.parse(r.publicado_en) > desde).length }
    }
    if (sql.includes('RETURNING') && sql.includes("SET estado='publicando'")) {
      // claimNext: prioridad DESC, luego id (con filtro de fuente opcional)
      const foco = focoDe(sql)
      const row = db.queue.filter(r => r.estado === 'pendiente' && (!foco || (r.fuente || 'ml') === foco))
        .sort((a, b) => (b.prioridad || 0) - (a.prioridad || 0) || a.id - b.id)[0]
      if (!row) return null
      Object.assign(row, { estado: 'publicando', intentos: row.intentos + 1, claimed_en: new Date().toISOString() })
      return { ...row }
    }
    if (sql.includes('FROM ig_config')) {
      const v = db.config.get(args[0])
      return v === undefined ? null : { valor: v }
    }
    throw sqlNoSoportada(sql)
  }
  return { run, all, first, bind(...a) { return makeStmt(db, sql, a.map(chequearTipo)) } }
}
