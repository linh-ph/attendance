FROM node:24.19.0-bookworm-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS test

RUN npx playwright install --with-deps chromium

COPY . ./

FROM deps AS builder

ARG NEXT_PUBLIC_GOOGLE_PICKER_API_KEY
ARG NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER
ENV NEXT_PUBLIC_GOOGLE_PICKER_API_KEY=$NEXT_PUBLIC_GOOGLE_PICKER_API_KEY
ENV NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER=$NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER

COPY . ./
RUN npm run build

FROM node:24.19.0-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

RUN groupadd --gid 1001 nodejs \
  && useradd --uid 1001 --gid nodejs --create-home nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
