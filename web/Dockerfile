FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build && chown -R node:node /app
USER node
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
CMD ["node", "server.mjs"]
