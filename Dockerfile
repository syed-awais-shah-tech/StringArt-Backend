# ==============================================================================
# StringArt Backend — Production Cloud Run Dockerfile
# Base: Debian Bookworm Slim with Node.js 20 (native glibc for Sharp)
# ==============================================================================

FROM node:20-bookworm-slim

WORKDIR /app

# Set container environment
ENV NODE_ENV=production
ENV PORT=8080

# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Cloud Run container contract: listen on PORT (default 8080)
EXPOSE 8080

# Launch Express server directly
CMD ["node", "index.js"]
