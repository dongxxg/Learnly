package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"learnly/backend/internal/config"
	"learnly/backend/internal/handler"
	"learnly/backend/internal/router"
	"learnly/backend/internal/store"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config failed: %v", err)
	}

	gin.SetMode(cfg.Server.Mode)

	db := store.NewPostgres(cfg.Postgres)
	rdb := store.NewRedis(cfg.Redis)

	deps := handler.Deps{DB: db, Redis: rdb}
	engine := router.New(deps)

	srv := &http.Server{
		Addr:         ":" + cfg.Server.Port,
		Handler:      engine,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	go func() {
		log.Printf("learnly-backend listening on :%s (mode=%s)", cfg.Server.Port, cfg.Server.Mode)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("shutting down backend...")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("forced shutdown: %v", err)
	}
}
