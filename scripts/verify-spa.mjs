// Verificacion del lote L8 (SPA). El SPA no tiene suite de tests; esto importa
// el modulo REAL y comprueba los fixes con asserts duros.
//   node scripts/verify-spa.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parsePrecioCLP, cleanTitle } from '../src/agents/orchestrator.js'

let ok = 0
const check = (nombre, fn) => { fn(); ok++; console.log('  ok  ' + nombre) }

console.log('F6 - precios (antes: "15.000" se publicaba como $15)')
check('formato chileno con punto de miles', () => assert.equal(parsePrecioCLP('15.000'), 15000))
check('con simbolo de peso', () => assert.equal(parsePrecioCLP('$15.000'), 15000))
check('con sufijo de moneda', () => assert.equal(parsePrecioCLP('15000 CLP'), 15000))
check('numero limpio', () => assert.equal(parsePrecioCLP(15000), 15000))
check('separador de miles con coma', () => assert.equal(parsePrecioCLP('1,250,000'), 1250000))
check('cero -> sin precio (no inventa 10.000)', () => assert.equal(parsePrecioCLP(0), null))
check('null -> sin precio', () => assert.equal(parsePrecioCLP(null), null))
check('undefined -> sin precio', () => assert.equal(parsePrecioCLP(undefined), null))
check('texto sin digitos -> sin precio', () => assert.equal(parsePrecioCLP('consultar'), null))
check('absurdamente bajo -> sin precio', () => assert.equal(parsePrecioCLP(15), null))
check('absurdamente alto -> sin precio', () => assert.equal(parsePrecioCLP('999999999'), null))

console.log('F10 - titulos (antes: "RX-7" quedaba "RX 7")')
check('conserva el guion del modelo', () =>
  assert.match(cleanTitle("Hot Wheels '95 Mazda RX-7 Escala 1/64"), /RX-7/))
check('conserva la escala con barra', () =>
  assert.match(cleanTitle("Hot Wheels '95 Mazda RX-7 Escala 1/64"), /1\/64/))
check('no se come el Full de Full HD', () =>
  assert.match(cleanTitle('Monitor Samsung Full HD 24'), /Full HD/))
check('conserva el decimal de la talla', () =>
  assert.match(cleanTitle('Zapatilla talla 42.5'), /42\.5/))
check('sigue borrando promociones', () => {
  const t = cleanTitle('Reloj Casio envío gratis 12 cuotas')
  assert.doesNotMatch(t, /gratis/i)
  assert.doesNotMatch(t, /cuotas/i)
  assert.match(t, /Casio/)
})
check('respeta el largo maximo de ML', () =>
  assert.ok(cleanTitle('x'.repeat(200)).length <= 60))

console.log('F3 - el flujo automatico ya no guarda gold_pro')
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
check('runAutoFlow guarda listingType free', () => {
  assert.ok(app.includes("editQty: 3, listingType: 'free',"),
    'el borrador del modo auto debe guardar el mismo listingType que fija el estado')
})
check('no quedo ningun gold_pro escrito a mano en el guardado', () => {
  assert.doesNotMatch(app, /listingType:\s*'gold_pro'/)
})

console.log('F2 - saveDraft ya no traga QuotaExceededError')
check('saveDraft no tiene catch vacio', () => assert.doesNotMatch(app, /catch\s*\{\s*\}\s*\n\}\s*\nfunction loadDrafts/))
check('saveDraft relanza si no logra guardar', () => {
  const cuerpo = app.slice(app.indexOf('function saveDraft'), app.indexOf('function loadDrafts'))
  assert.match(cuerpo, /QuotaExceededError/)
  assert.match(cuerpo, /throw e/)
})

console.log('F4 - ganancia del historial (antes: el lote no descontaba comision ni envio)')
const lote = app.slice(app.indexOf('const publishBatch'), app.indexOf('setDrafts(loadDrafts())', app.indexOf('const publishBatch')))
check('el lote ya no guarda precio - costo', () => {
  assert.doesNotMatch(lote, /ganancia_neta:\s*draft\.editPrice\s*-\s*\(draft\.productCost/)
})
check('el lote consulta la comision real de ML', () => {
  assert.match(lote, /fetchSaleFee\(/)
  assert.match(lote, /listing_prices\?price=/)
})
check('el lote usa el listingType del borrador, no uno fijo', () =>
  assert.match(lote, /listing_type_id=\$\{tipoPub\}/))
check('el lote descuenta el envio cuando es gratis', () =>
  assert.match(lote, /draft\.freeShipping \? \(draft\.shippingCost/))
check('sin comision conocida el lote guarda null, no una cifra inflada', () =>
  assert.match(lote, /fee == null \? null :/))
check('publish() tampoco guarda ganancia si no conoce la comision', () => {
  const uno = app.slice(app.indexOf('const profitNow'), app.indexOf('setHistorial(loadHistory())'))
  assert.match(uno, /typeof feeReal === 'number'/)
  assert.match(uno, /: null/)
})
check('el historial muestra un guion en vez de +$NaN', () =>
  assert.match(app, /h\.ganancia_neta == null \? '—'/))

console.log(`\n${ok} comprobaciones OK`)
