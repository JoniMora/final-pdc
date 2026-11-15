FROM node:22-alpine

# Instala las dependencias del código compartido.
WORKDIR /app/compartido

COPY --from=compartido package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=compartido src ./src

# Copia los contratos que utiliza la API.
COPY --from=contrato openapi.yaml asyncapi.yaml /app/contrato/

# Instala las dependencias propias de la API.
WORKDIR /app/servicios/api

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

USER node

EXPOSE 3000

CMD ["npm", "start"]