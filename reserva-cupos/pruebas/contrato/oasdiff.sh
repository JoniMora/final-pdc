#!/bin/sh
# Compara contrato/openapi.yaml (o el archivo indicado) con el de otra
# versión del repositorio y falla si encuentra cambios incompatibles.
#
# Uso, desde reserva-cupos:
#   pruebas/contrato/oasdiff.sh [referencia] [archivo]
#   pruebas/contrato/oasdiff.sh v3-comunicacion
#
# La referencia es un tag, una rama o un commit (por defecto, origin/main).
set -e

REFERENCIA=${1:-origin/main}
NUEVO=${2:-contrato/openapi.yaml}
DIRECTORIO=$(mktemp -d)
trap 'rm -rf "$DIRECTORIO"' EXIT

git show "$REFERENCIA:reserva-cupos/contrato/openapi.yaml" > "$DIRECTORIO/base.yaml"
cp "$NUEVO" "$DIRECTORIO/nuevo.yaml"
cp contrato/oasdiff-excepciones.txt "$DIRECTORIO/"

docker run --rm -v "$DIRECTORIO:/specs:ro" tufin/oasdiff:v1.11.7 \
    breaking /specs/base.yaml /specs/nuevo.yaml \
    --fail-on ERR --err-ignore /specs/oasdiff-excepciones.txt
