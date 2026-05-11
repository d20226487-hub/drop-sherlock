# --- deps stage --------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

RUN npm config set fetch-timeout 600000 \
 && npm config set fetch-retries 8 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm config set registry https://registry.npmjs.org/

COPY package.json package-lock.json* ./

RUN npm install --no-audit --no-fund --prefer-online --loglevel=http

# --- build stage -------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_API_BASE=/api
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
RUN npm run build

# --- runner stage ------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

USER node

EXPOSE 3000
CMD ["node", "server.js"]
