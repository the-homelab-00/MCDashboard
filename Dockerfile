# Stage 1: Build Stage
FROM oven/bun:latest AS builder
WORKDIR /app

# 1. Install build dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    gcc \
    cmake \
    && rm -rf /var/lib/apt/lists/*

# 2. Copy backend lockfiles and install
COPY backend/package.json backend/bun.lock ./backend/
RUN cd backend && bun install --frozen-lockfile

RUN cd backend/node_modules/raknet-native/raknet/Source && \
    # 1. Update the negotiation array in RakPeer.cpp
    sed -i 's/MAXIMUM_MTU_SIZE, 1200, 576/1200, 1200, 576/g' RakPeer.cpp && \
    # 2. Update the hard limit in MTUSize.h
    sed -i 's/#define MAXIMUM_MTU_SIZE 1492/#define MAXIMUM_MTU_SIZE 1200/g' MTUSize.h

RUN cd /app/backend/node_modules/raknet-native && \
    rm -rf build && \
    bun run install --build-from-source

# 3. FIX: Manually move the RakNet bindings to the folder the 'bindings' library expects
# Your 'find' command showed the file at prebuilds/linux-5-x64/node-raknet.node
RUN mkdir -p /app/backend/node_modules/raknet-native/prebuilds/linux-6-x64/ && \
    cp /app/backend/node_modules/raknet-native/build/Release/node-raknet.node \
       /app/backend/node_modules/raknet-native/prebuilds/linux-6-x64/node-raknet.node
# 4. Copy the rest of the project
COPY . .

# 5. Build the frontend with placeholders for runtime injection
RUN cd frontend && \
    bun install && \
    VITE_API_URL=__VITE_API_URL__ VITE_WS_URL=__VITE_WS_URL__ bun run build

# Stage 2: Runtime Stage
FROM oven/bun:latest
WORKDIR /app

# 6. Install runtime dependencies (OpenSSL for Auth, libstdc++ for RakNet)
RUN apt-get update && apt-get install -y \
    openssl \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

# 7. Copy built assets and backend from builder
COPY --from=builder /app/frontend/dist ./frontend/dist
COPY --from=builder /app/backend ./backend

# 8. Set up execution environment
WORKDIR /app/backend
ENV NODE_ENV=production
EXPOSE 3001

# 9. Start the server

CMD ["bun", "run", "server.ts"]
