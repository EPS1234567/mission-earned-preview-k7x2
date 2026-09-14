# Railway detects a Dockerfile at the service root and builds with it, so the
# build is identical here, in CI, and on a laptop.
#
# Node 22 is Active LTS with security support into 2027. Pin the minor so a
# rebuild months from now produces the same runtime.
FROM node:22.21-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first: this layer is cached unless the manifest changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Never run the app as root. If a Railway Volume is used for documents, its
# mount is root-owned, so either chown it in the Railway shell once or use
# object storage (STORAGE_DRIVER=s3) instead — see README.
USER node

# Railway injects PORT and routes to it.
EXPOSE 3000
CMD ["node", "src/index.js"]
