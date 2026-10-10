# Своя игра — образ для хостинга
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN chown -R node:node /app
USER node
# хостинг обычно сам задаёт PORT; если нет — 3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1
CMD ["node", "server.js"]
