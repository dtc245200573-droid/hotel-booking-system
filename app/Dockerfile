FROM node:20-alpine
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY . .
# Hardening: Chạy bằng non-root user hoteluser
RUN addgroup -g 1001 -S hotelgroup && \
    adduser -S hoteluser -u 1001 -G hotelgroup && \
    chown -R hoteluser:hotelgroup /usr/src/app
USER hoteluser
EXPOSE 3000
CMD ["node", "server.js"]
