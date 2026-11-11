#!/bin/sh
# Compara el contrato de mensajería (contrato/asyncapi.yaml) con el de otra
# versión del repositorio y falla si encuentra un cambio incompatible. Es el
# equivalente de oasdiff.sh para los mensajes de RabbitMQ: valida los
# ejemplos de cada versión contra los esquemas de la otra (ver
# compartido/src/compatibilidad.js).
#
# Uso, desde reserva-cupos (requiere npm ci en compartido):
#   pruebas/contrato/compatibilidad-mensajes.sh [referencia] [directorio]
#   pruebas/contrato/compatibilidad-mensajes.sh v3-comunicacion
#
# La referencia es un tag, una rama o un commit (por defecto, origin/main).
# El directorio es el del contrato nuevo (por defecto, contrato).
set -e

REFERENCIA=${1:-origin/main}
NUEVO=${2:-contrato}
BASE=$(mktemp -d)
trap 'rm -rf "$BASE"' EXIT

if ! git cat-file -e "$REFERENCIA:reserva-cupos/contrato/asyncapi.yaml" 2>/dev/null; then
    echo "$REFERENCIA no tiene contrato de mensajería: no hay una versión anterior con la que comparar."
    exit 0
fi

# asyncapi.yaml toma las entidades de openapi.yaml: van los dos.
git show "$REFERENCIA:reserva-cupos/contrato/asyncapi.yaml" > "$BASE/asyncapi.yaml"
git show "$REFERENCIA:reserva-cupos/contrato/openapi.yaml" > "$BASE/openapi.yaml"

node compartido/src/compatibilidad.js "$BASE" "$NUEVO"
