FROM node:22-alpine

# Valida las llamadas a la API y los webhooks con el mismo contrato que la
# API, y verifica la firma con el código común de los clientes.
WORKDIR /app/compartido
COPY --from=compartido package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=compartido src ./src
COPY --from=contrato openapi.yaml asyncapi.yaml /app/contrato/

WORKDIR /app/clientes/vitrina

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

USER node

CMD ["npm", "start"]
