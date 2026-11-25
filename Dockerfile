# syntax=docker/dockerfile:1
FROM node:22-alpine

# GitHub CLI powers the assisted device-code sign-in.
RUN apk add --no-cache github-cli tini

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data/builds \
    GH_CONFIG_DIR=/data/gh

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY extensions ./extensions
ARG MAC_COMMIT=""
ARG MAC_BUILT_AT=""
ENV MAC_COMMIT=$MAC_COMMIT MAC_BUILT_AT=$MAC_BUILT_AT

RUN mkdir -p /data/builds /data/gh && chown -R node:node /data \
    && chmod +x /app/src/cli.js && ln -s /app/src/cli.js /usr/local/bin/mac
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
