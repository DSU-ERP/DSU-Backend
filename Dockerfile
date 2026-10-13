FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node src ./src
USER node
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "src/server.js"]
