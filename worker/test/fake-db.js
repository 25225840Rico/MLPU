// FakeDB: imita el subset de la API de D1 que usan ig-api.js e ig-queue.js.
// Soporta las queries por texto (match por fragmento), suficiente para unit tests.
export class FakeDB {
  constructor() { this.config = new Map(); this.queue = []; this.nextId = 1 }

  async seedConfig(clave, valor) { this.config.set(clave, valor) }
  async getConfig(clave) { return this.config.get(clave) }
  seedQueue(row) {
    const r = { id: this.nextId++, estado: 'pendiente', intentos: 0, ultimo_error: null,
      ig_media_id: null, ig_story_id: null, publicado_en: null, ...row }
    this.queue.push(r); return r
  }

  prepare(sql) { return makeStmt(this, sql, []) }
}

function makeStmt(db, sql, args) {
  const run = async () => {
    let changes = 0
    if (sql.includes('ON CONFLICT(ml_item_id)')) {
      const [ml_item_id, titulo, precio, permalink_ml] = args
      const row = db.queue.find(r => r.ml_item_id === ml_item_id)
      if (!row) { db.seedQueue({ ml_item_id, titulo, precio, permalink_ml, creado_en: new Date().toISOString() }); changes = 1 }
      else if (row.estado === 'cancelado') { Object.assign(row, { estado: 'pendiente', intentos: 0, ultimo_error: null }); changes = 1 }
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
    } else if (sql.includes('UPDATE ig_queue') && sql.includes("WHERE estado='pendiente'") && !args.length) {
      for (const r of db.queue) if (r.estado === 'pendiente') { r.estado = 'cancelado'; changes++ }
    } else if (sql.includes('UPDATE ig_queue')) {
      const id = args[args.length - 1]
      const row = db.queue.find(r => r.id === id)
      if (row) {
        changes = 1
        if (sql.includes("estado='publicado'")) {
          Object.assign(row, { estado: 'publicado', ig_media_id: args[0], ig_story_id: args[1], publicado_en: new Date().toISOString() })
        } else if (sql.includes('intentos=intentos+1')) {
          row.intentos++; row.ultimo_error = args[0]
          if (row.intentos >= 3) row.estado = 'error'
        } else if (sql.includes("estado='cancelado'")) {
          if (sql.includes("estado='pendiente'") && row.estado !== 'pendiente') changes = 0
          else row.estado = 'cancelado'
        }
      }
    }
    return { success: true, meta: { changes } }
  }
  const all = async () => {
    if (sql.includes('FROM ig_queue')) {
      let rows = db.queue.filter(r => r.estado === 'pendiente')
      const m = sql.match(/LIMIT (\d+)/)
      if (m) rows = rows.slice(0, Number(m[1]))
      return { results: rows }
    }
    return { results: [] }
  }
  const first = async () => {
    if (sql.includes('FROM ig_config')) {
      const v = db.config.get(args[0])
      return v === undefined ? null : { valor: v }
    }
    return null
  }
  return { run, all, first, bind(...a) { return makeStmt(db, sql, a) } }
}
