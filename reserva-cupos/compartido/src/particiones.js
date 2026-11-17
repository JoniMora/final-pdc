function entero(valor, nombre) {
    if (!/^\d+$/.test(String(valor))) {
        throw new Error(`${nombre} debe ser un entero`);
    }

    const numero = Number(valor);

    if (!Number.isSafeInteger(numero)) {
        throw new Error(`${nombre} está fuera de rango`);
    }

    return numero;
}

function configurarParticiones(entorno = process.env) {
    const cantidad = entero(
        entorno.COMANDOS_PARTICIONES ?? "1",
        "COMANDOS_PARTICIONES"
    );

    if (cantidad < 1 || cantidad > 32) {
        throw new Error(
            "COMANDOS_PARTICIONES debe estar entre 1 y 32"
        );
    }

    const indice = entero(
        entorno.WORKER_PARTICION ?? "0",
        "WORKER_PARTICION"
    );

    if (indice < 0 || indice >= cantidad) {
        throw new Error(
            "WORKER_PARTICION debe identificar una partición existente"
        );
    }

    const colas = Array.from(
        { length: cantidad },
        (_, numero) => `reservas.comandos.${numero}`
    );

    return {
        cantidad,
        indice,
        colas,
        cola: colas[indice]
    };
}

module.exports = { configurarParticiones };