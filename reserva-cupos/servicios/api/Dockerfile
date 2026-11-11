FROM node:22-alpine

# Misma estructura que el repositorio: el contrato queda en /app/contrato y
# la API lo lee desde servicios/api/src con ../../../contrato.
COPY --from=contrato openapi.yaml asyncapi.yaml /app/contrato/

WORKDIR /app/servicios/api

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

USER node

EXPOSE 3000

CMD ["npm", "start"]
