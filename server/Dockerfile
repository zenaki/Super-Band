# Server collection Super Band untuk stack Docker (mis. di belakang Traefik).
# Build dari root repo:  docker build -f server/Dockerfile -t super-band-collection .
FROM python:3.12-alpine
RUN adduser -D -u 10001 superband && mkdir -p /data && chown superband /data
COPY server/superband_server.py /app/superband_server.py
USER superband
ENV SB_DATA=/data SB_HOST=0.0.0.0 SB_PORT=8787 PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/api/ping || exit 1
CMD ["python3", "/app/superband_server.py", "serve"]
