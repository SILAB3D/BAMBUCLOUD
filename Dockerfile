FROM node:22-alpine

WORKDIR /app

# El lockfile entra en la imagen para que el build sea reproducible.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
# El agente de camara vive en la misma imagen: docker-compose lo arranca como
# un segundo servicio con otro CMD.
COPY agent ./agent

# Aqui se cachea el accessToken. Montar un volumen en /data evita tener que
# meter el codigo del email en cada reinicio del contenedor.
ENV NODE_ENV=production \
    TOKEN_FILE=/data/bambu-token.json
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "src/server.js"]
