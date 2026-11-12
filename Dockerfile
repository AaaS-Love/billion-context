# billion-context, AaaS-Love local-only fork, in a container.
#
# Builds THIS checkout (never the npm registry copy), installs the packed
# tarball, and runs the proxy bound to 127.0.0.1 only: the fork refuses any
# other bind address. A loopback bind inside a container is not reachable via
# `-p`; on Linux run it in the host network namespace so 127.0.0.1 is the
# host's loopback:
#
#   docker build -t billion-context-local .
#   docker run -d --name bili --network host \
#     -v bili-state:/root/.local/state/billion-context \
#     -v bili-data:/root/.local/share/billion-context \
#     billion-context-local
#
# Data at rest and how to wipe it: docs/AAAS-FORK.md.

FROM node:24-slim AS build
WORKDIR /src
COPY . .
RUN npm ci --no-audit --no-fund && npm run build && npm pack --pack-destination /out

FROM node:24-slim
COPY --from=build /out/*.tgz /tmp/
RUN npm install -g --no-audit --no-fund /tmp/*.tgz && rm -f /tmp/*.tgz

ENV ACP_AUTO_UPDATE=0

VOLUME ["/root/.config/billion-context", "/root/.local/share/billion-context", "/root/.cache/billion-context", "/root/.local/state/billion-context"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/__bili/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bili", "start", "--host", "127.0.0.1", "--port", "8787"]
