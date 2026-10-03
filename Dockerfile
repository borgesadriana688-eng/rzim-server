FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && apt-get clean
WORKDIR /app
COPY . .
RUN (npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund)
RUN cd auth && (npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund)
EXPOSE 8080
CMD ["sh", "-c", "node src/db/migrate.js && node railway_boot.js"]
