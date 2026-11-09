# Hooks de Schemathesis para la verificación del proveedor (se cargan con
# SCHEMATHESIS_HOOKS=/config/hooks.py).
import re
import uuid

import schemathesis

# Valores que el contrato admite para Idempotency-Key.
CLAVE_VALIDA = re.compile(r"^[\x21-\x7e]{1,128}$")


@schemathesis.hook
def before_call(context, case, kwargs):
    """Cada solicitud válida lleva una Idempotency-Key nueva.

    Schemathesis genera claves cortas que se repiten entre casos con cuerpos
    distintos, y la API responde 422 (clave reutilizada, regla documentada).
    Así casi ninguna reserva se crea y la fase con estado no llega a
    consultarla ni a cancelarla. Las claves inválidas no se tocan: siguen
    probando que la API las rechace.
    """
    for nombre, valor in list((case.headers or {}).items()):
        if nombre.lower() == "idempotency-key" and isinstance(valor, str) and CLAVE_VALIDA.match(valor):
            case.headers[nombre] = str(uuid.uuid4())
