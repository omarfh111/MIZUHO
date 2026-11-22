# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS web
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
    && npm ci --no-audit --no-fund
COPY frontend/ ./
ENV VITE_DATA_MODE=live
RUN npm run build

FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MIZHUO_CORS_ORIGINS="" \
    HOME=/tmp
WORKDIR /app
COPY requirements.txt ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export PIP_CERT=/run/secrets/build_ca; fi \
    && python -m pip install --no-cache-dir -r requirements.txt
COPY backend/ backend/
COPY data/ data/
COPY docs/evidence/ docs/evidence/
COPY tools/m2m3/ tools/m2m3/
COPY --from=web /build/dist frontend/dist/
ARG MIZUHO_RELEASE_SHA=development
ENV MIZUHO_RELEASE_SHA=$MIZUHO_RELEASE_SHA
USER 10001:10001
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "backend.deployment:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log", "--no-proxy-headers", "--ws", "websockets", "--ws-max-size", "3145728"]
