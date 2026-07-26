/**
 * [IG] Presupuesto de subrequests por invocación del Worker.
 *
 * El plan Free de Cloudflare permite 50 fetch() externos POR INVOCACIÓN (las
 * llamadas a bindings como D1 tienen su propio límite, mucho más alto). Al
 * pasarse, Cloudflare mata la invocación en seco: la corrida muere a mitad, la
 * fila queda reclamada en 'publicando' y recién se recupera 10 min después.
 *
 * Costo real de una fila (medido sobre el flujo de publicarFila):
 *   getItem de ML ............ 1   (las filas 'drive' no lo gastan)
 *   feed:    crear + polls + publicar ...  3 mínimo, ~14 en el peor caso
 *   historia: idem                        3 mínimo, ~14 en el peor caso
 *   aviso a Telegram ......... 1
 *   → ~8 en el caso bueno, ~30 en el peor.
 *
 * Con esto el publisher deja de adivinar: consulta cuánto queda antes de
 * reclamar otra fila y corta limpio (las pendientes las toma el tick siguiente,
 * que es un minuto después) en vez de reventar el límite a mitad de una
 * publicación. Y waitForContainer deja de pollear cuando el presupuesto se
 * acaba, en vez de gastarlo todo esperando.
 *
 * El estado es de módulo: los isolates de Workers se reutilizan entre
 * invocaciones, así que SIEMPRE hay que llamar a iniciarPresupuesto() al
 * arrancar la corrida. Si dos corridas compartieran isolate el contador queda
 * conservador (corta antes), nunca optimista.
 */

// 50 del plan Free menos un colchón para lo que no pasa por aquí (avisos de
// Telegram del propio publisher, renovación de token de ML).
export const TOPE_FREE = 50
const COLCHON = 6

let usados = 0
let tope = TOPE_FREE - COLCHON

export function iniciarPresupuesto(topeTotal = TOPE_FREE) {
  usados = 0
  tope = Math.max(1, topeTotal - COLCHON)
}

/** Registra n subrequests. Devuelve false si con esto se pasó del tope. */
export function gastar(n = 1) {
  usados += n
  return usados <= tope
}

export const restante = () => Math.max(0, tope - usados)
export const hayPara = n => restante() >= n

/** Solo para tests / diagnóstico. */
export const _estado = () => ({ usados, tope })
