FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build


FROM node:24-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/scripts/migrate-database.ts ./scripts/migrate-database.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/tsconfig.server.json ./tsconfig.server.json

RUN addgroup -S antytilt && adduser -S -G antytilt antytilt \
  && chown -R antytilt:antytilt /app

USER antytilt

EXPOSE 8787

CMD ["npm", "run", "start:api"]
