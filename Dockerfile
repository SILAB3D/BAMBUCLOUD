FROM node:22-alpine

WORKDIR /app

# El lockfile entra en la imagen para que el build sea reproducible.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
# Catalogo oficial de codigos de error de Bambu Lab (ver src/error-codes.js).
COPY data ./data
# El agente de camara vive en la misma imagen: docker-compose lo arranca como
# un segundo servicio con otro CMD.
COPY agent ./agent

# Aqui se cachea el accessToken. Montar un volumen en /data (ver
# docker-compose.yml) evita tener que meter el codigo del email en cada
# reinicio. Sin volumen el fichero es efimero y hace falta BAMBU_TOKEN.
#
# No se declara VOLUME: en plataformas sin discos persistentes solo genera un
# volumen anonimo por contenedor. El compose ya declara el suyo.
ENV NODE_ENV=production \
    TOKEN_FILE=/data/bambu-token.json
RUN mkdir -p /data

EXPOSE 3000

# El puerto se resuelve en tiempo de ejecucion: plataformas como Render
# inyectan su propio $PORT y sondear el 3000 fijo fallaba siempre, lo que saca
# al contenedor del enrutado. Forma shell (no exec) para que $PORT se expanda.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null || exit 1

CMD ["node", "src/server.js"]
