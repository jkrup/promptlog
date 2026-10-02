# promptlog's stock review page, run in a Cloudflare Container. Build context: the repo root (see wrangler.jsonc).
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY cloud/viewer/container/entry.mjs ./entry.mjs
RUN git config --global --add safe.directory '*'
EXPOSE 8080
CMD ["node", "/app/entry.mjs"]
