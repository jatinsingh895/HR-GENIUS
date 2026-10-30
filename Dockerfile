FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/app/storage/hrgenius.sqlite

COPY --chown=node:node package.json server.js app.js index.html styles.css auth.css settings.css ./
COPY --chown=node:node data/seed.json ./data/seed.json
RUN mkdir -p /app/storage && chown -R node:node /app/storage

USER node
VOLUME ["/app/storage"]
EXPOSE 3000
CMD ["node", "server.js"]
