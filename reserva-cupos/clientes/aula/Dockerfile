FROM node:22-alpine

# Aula valida sus llamadas y los webhooks con el mismo contrato que la API.
WORKDIR /app/compartido
COPY --from=compartido package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=compartido src ./src
COPY --from=contrato openapi.yaml asyncapi.yaml /app/contrato/

WORKDIR /app/clientes/aula

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

USER node

EXPOSE 3001

CMD ["npm", "start"]
