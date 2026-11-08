FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
WORKDIR /app
COPY package.json ./
COPY server.js store.js worker.js provider.js utils.js ./
COPY public/ ./public/
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]
USER node
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
