# Stage 1: Build Stage
FROM oven/bun:latest AS builder
WORKDIR /app



# 2. Copy backend lockfiles and install
COPY backend/package.json backend/bun.lock ./backend/
RUN cd backend && bun install --frozen-lockfile


# 5. Build the frontend with placeholders for runtime injection
RUN cd frontend && \
    bun install && \
    VITE_API_URL=__VITE_API_URL__ VITE_WS_URL=__VITE_WS_URL__ bun run build

# Stage 2: Runtime Stage
FROM oven/bun:latest
WORKDIR /app


# 7. Copy built assets and backend from builder
COPY --from=builder /app/frontend/dist ./frontend/dist
COPY --from=builder /app/backend ./backend

# 8. Set up execution environment
WORKDIR /app/backend
ENV NODE_ENV=production
EXPOSE 3001

# 9. Start the server

CMD ["bun", "run", "server.ts"]
