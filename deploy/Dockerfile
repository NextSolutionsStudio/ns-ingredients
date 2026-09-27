# Build from the repo root:  docker build -f deploy/Dockerfile -t ns-ingredients .
ARG DENO_VERSION=2.9.5
FROM denoland/deno:${DENO_VERSION}

WORKDIR /app
COPY deno.json deno.lock ./
COPY src ./src
COPY kb ./kb
# Fetch every dependency at build time; the container never downloads code at runtime.
RUN deno cache --frozen src/main.ts src/cli/keys.ts

USER deno
ENV PORT=8029 \
    HOST=0.0.0.0 \
    KB_DIR=/app/kb
EXPOSE 8029

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["deno", "eval", "const r = await fetch('http://127.0.0.1:8029/ready'); if (!r.ok) Deno.exit(1);"]

CMD ["run", "--cached-only", "--frozen", "--allow-net", "--allow-env", "--allow-read=/app", "src/main.ts"]
