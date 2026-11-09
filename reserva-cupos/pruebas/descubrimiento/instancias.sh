#!/bin/sh
# Muestra las instancias de la API que descubrió Traefik y su estado, según
# el panel (puerto 8080). Con --esperar N, antes espera hasta 60 s a que
# Traefik tenga exactamente N instancias UP: una instancia nueva aparece
# cuando Docker la marca healthy, y una detenida desaparece.
#
# Uso, desde reserva-cupos, con el entorno levantado:
#   pruebas/descubrimiento/instancias.sh
#   pruebas/descubrimiento/instancias.sh --esperar 3
set -e

PANEL=${PANEL:-http://localhost:8080}

servicio() {
    curl -s "$PANEL/api/http/services/api@docker"
}

instancias_up() {
    servicio | python3 -c '
import json, sys
try:
    estados = json.load(sys.stdin).get("serverStatus", {})
except ValueError:
    estados = {}
print(sum(1 for estado in estados.values() if estado == "UP"))'
}

if [ "$1" = "--esperar" ]; then
    esperadas=$2
    segundos=0

    while [ "$(instancias_up)" != "$esperadas" ]; do
        if [ "$segundos" -ge 60 ]; then
            echo "Después de 60 s, Traefik no tiene $esperadas instancias UP" >&2
            exit 1
        fi

        sleep 1
        segundos=$((segundos + 1))
    done

    echo "Traefik tiene $esperadas instancias UP (esperó $segundos s)"
fi

servicio | python3 -c '
import json, sys
datos = json.load(sys.stdin)
print("servicio api@docker:", datos["status"])
for url, estado in sorted(datos["serverStatus"].items()):
    print(" ", url, "→", estado)'
