FROM node:22-alpine

# Misma estructura que el repositorio: el código compartido y el contrato
# quedan en /app/compartido y /app/contrato, y la API los alcanza desde
# servicios/api/src con ../../../. Del módulo compartido la API usa solo
# las conexiones TLS (compartido/src/tls.js), que no tiene dependencias.
COPY --from=compartido src /app/compartido/src
COPY --from=contrato openapi.yaml asyncapi.yaml /app/contrato/

WORKDIR /app/servicios/api

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

USER node

EXPOSE 3000

CMD ["npm", "start"]
