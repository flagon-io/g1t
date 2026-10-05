# g1t's git store for self-hosting: bare repositories on a volume, served
# by git itself. See server.mjs.
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.mjs ./
ENV GITSTORE_ROOT=/data/git GITSTORE_PORT=8080
# Owned by the user it runs as, so new volumes are writable.
RUN mkdir -p /data/git /secrets && chown node:node /data/git /secrets
VOLUME /data/git
EXPOSE 8080
USER node
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
