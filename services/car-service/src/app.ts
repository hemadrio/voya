/**
 * Car-service Express application factory.
 *
 * Mounts the car search router at /v1/cars and wires the shared error
 * handler so all unhandled exceptions produce the standard envelope.
 */

import express from 'express';
import { createErrorHandler } from '../../../shared/middleware/errorHandler.js';
import { createCarSearchRouter } from './routes/carSearchRoutes.js';
import type { ICarSearchService } from './domain/CarSearchService.js';
import type { HealthHandlers } from '@travel/observability';

export interface CarAppOptions {
  carSearchService: ICarSearchService;
  healthHandlers?: HealthHandlers;
}

export function createApp(options: CarAppOptions): express.Application {
  const { carSearchService, healthHandlers } = options;

  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.use('/v1/cars', createCarSearchRouter({ carSearchService }));

  if (healthHandlers !== undefined) {
    app.get('/health/live', healthHandlers.liveHandler.bind(healthHandlers));
    app.get('/health/ready', (req, res, next) => {
      (healthHandlers.readyHandler(req, res) as Promise<unknown>).catch(next);
    });
  } else {
    app.get('/health/live', (_req, res) =>
      res.json({ status: 'alive', uptimeSeconds: Math.floor(process.uptime()) }),
    );
    app.get('/health/ready', (_req, res) => res.json({ status: 'ok' }));
  }

  app.use(createErrorHandler());

  return app;
}
