FROM node:22-alpine

# Misma estructura que el repositorio: el código compartido y el contrato
# quedan en /app/compartido y /app/contrato, y el servicio los alcanza
# desde servicios/notificador/src con ../../../.
WORKDIR /app/compartido
COPY --from=compartido package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=compartido src ./src
COPY --from=contrato openapi.yaml asyncapi.yaml /app/contrato/

WORKDIR /app/servicios/notificador

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

USER node

CMD ["npm", "start"]
