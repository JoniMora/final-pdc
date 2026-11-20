const CircuitBreaker = require('opossum');

class ErrorHttp extends Error {
    constructor(status) { super(`El receptor respondio HTTP ${status}`); this.status = status; }
}

function crearCircuitos({ enviar, metricas, onTransicion = () => {},
    resetTimeout = 10000, volumeThreshold = 3, maximo = 1000, errorFilter = () => false }) {
    if (!(resetTimeout > 0) || !(volumeThreshold > 0) || !(maximo > 0)) {
        throw new Error('Configuracion de circuitos invalida');
    }
    const circuitos = new Map();
    const codigos = { cerrado: 0, abierto: 1, semiabierto: 2 };
    function obtener(tenant) {
        let entrada = circuitos.get(tenant);
        if (entrada) { entrada.ultimo = Date.now(); return entrada.breaker; }
        if (circuitos.size >= maximo) {
            // Desalojar solo circuitos cerrados, inactivos y sin HTTP en vuelo.
            const candidato = [...circuitos].find(([, e]) => e.breaker.closed
                && !e.activos && Date.now() - e.ultimo > 60000);
            if (!candidato) {
                const error = new Error('Capacidad de circuitos ocupada; diferir sin intentar HTTP');
                error.code = 'EOPENBREAKER';
                throw error;
            }
            candidato[1].breaker.shutdown();
            circuitos.delete(candidato[0]);
            metricas?.estado.remove(candidato[0]);
            for (const estado of Object.keys(codigos)) metricas?.transiciones.remove(candidato[0], estado);
        }
        entrada = { ultimo: Date.now(), activos: 0 };
        const breaker = new CircuitBreaker(async (...args) => {
            entrada.activos++;
            try {
                const status = await enviar(...args);
                if (status < 200 || status >= 300) throw new ErrorHttp(status);
                return status;
            } finally { entrada.activos--; }
        }, { timeout: false, resetTimeout, volumeThreshold,
            errorThresholdPercentage: 50, rollingCountTimeout: 30000,
            errorFilter });
        entrada.breaker = breaker;
        circuitos.set(tenant, entrada);
        function registrar(estado) {
            metricas?.estado.set({ tenant }, codigos[estado]);
            metricas?.transiciones.inc({ tenant, estado });
            onTransicion({ tenant, estado, instante: new Date().toISOString() });
        }
        breaker.on('open', () => registrar('abierto'));
        breaker.on('halfOpen', () => registrar('semiabierto'));
        breaker.on('close', () => registrar('cerrado'));
        registrar('cerrado');
        return breaker;
    }
    return {
        ejecutar(tenant, ...args) { return obtener(tenant).fire(...args); },
        cerrar() { for (const { breaker } of circuitos.values()) breaker.shutdown(); circuitos.clear(); }
    };
}

module.exports = { crearCircuitos, ErrorHttp };
