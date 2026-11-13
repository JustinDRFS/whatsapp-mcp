# Image du service : on compile, puis on garde seulement ce qui sert à tourner.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Le dossier /data (base + identifiants WhatsApp) appartient à l'utilisateur non privilégié « node ».
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
CMD ["node", "--no-warnings=ExperimentalWarning", "dist/index.js"]
