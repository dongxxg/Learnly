# syntax=docker/dockerfile:1
# 仅构建 H5 产物。小程序/App 需在本地构建后用对应 IDE 上传。
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build:h5

FROM nginx:1.27-alpine
COPY --from=builder /app/dist/build/h5 /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
