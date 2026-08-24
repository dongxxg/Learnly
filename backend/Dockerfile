# syntax=docker/dockerfile:1
# ---------- build ----------
FROM golang:1.24-alpine AS builder
WORKDIR /app
# go.mod 中 replace github.com/dongxxg/go-tools => ./pkg，需先拷贝 pkg 才能 download
COPY go.mod go.sum ./
COPY pkg ./pkg
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/server ./cmd/server

# ---------- runtime ----------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone
WORKDIR /app
COPY --from=builder /out/server .
# pkg/config 按二进制同级 conf/ 目录发现配置文件
COPY --from=builder /app/cmd/server/conf ./conf
EXPOSE 8080
ENTRYPOINT ["./server"]
